package dev.example.commoncorepoc

import android.app.Activity
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * WebMessageChannelによるバイナリデータプレーン (Android専用)。
 *
 * JSは `window.corebin.postMessage(buf, [buf.buffer])` でArrayBufferを送り、
 * 応答もArrayBufferで受け取る。base64・URL長の制限を受けない真バイナリ経路。
 * 計算は共通Rust `process_batch` (JNI) で行い、再実装しない。
 *
 * 注意:
 * - WebViewの取得はTauri管理下のためView走査で行う。見つからなければ何もせず
 *   (従来のinvoke/scheme経路が使われる)。gen/androidの再生成時はこの結線の
 *   再適用が必要 (`MainActivity.onCreate` の呼び出し1行と本ファイル)。
 * - リスナーはメインスレッドで呼ばれる。Rust処理は数十μs級のため同期で返す。
 * - 失敗時は空応答で速やかに失敗させる (JS側TRANSPORT_ERROR。無応答にしない)。
 */
object CorebinPort {
  const val NAME = "corebin"
  private const val TAG = "CorebinPort"
  private const val MAX_ATTACH_ATTEMPTS = 100
  private const val ATTACH_RETRY_MS = 100L
  private val attempts = java.util.concurrent.atomic.AtomicInteger(0)
  @Volatile private var attached = false
  private val ORIGINS: Set<String> = setOf("http://tauri.localhost", "https://tauri.localhost")

  init {
    // libはTauri起動時に読込済みだが、直接呼ばれた場合にも壊れないよう明示する (多重読込は無害)。
    try {
      System.loadLibrary("core_app_lib")
    } catch (_: Throwable) {
      // 未読込ならTauri側の読込に任せる。失敗はhandleBatch呼出時に表面化する。
    }
  }

  @JvmStatic
  external fun handleBatch(input: ByteArray): ByteArray?

  /** Activity直下からWebViewを探してリスナーを付ける。Tauriの生成より
   * 早い場合は最大約10秒まで再試行する (onCreate/onResumeの双方から呼ぶ)。 */
  fun attachToContentView(activity: Activity) {
    if (attached) return
    val root = activity.findViewById<ViewGroup>(android.R.id.content)
    if (root == null) {
      Log.w(TAG, "content view missing")
      return
    }
    val webView = findWebView(root)
    if (webView != null) {
      if (attach(webView)) {
        attached = true
      }
      return
    }
    // Tauriの生成タイミング次第で遅れる場合に備え、有界回数だけ遅延再試行する。
    if (attempts.incrementAndGet() <= MAX_ATTACH_ATTEMPTS) {
      root.postDelayed({ attachToContentView(activity) }, ATTACH_RETRY_MS)
    } else {
      Log.w(TAG, "webview not found, giving up")
    }
  }

  private fun findWebView(v: View): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  private fun attach(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      Log.w(TAG, "WEB_MESSAGE_LISTENER unsupported")
      return false
    }
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
      Log.w(TAG, "WEB_MESSAGE_ARRAY_BUFFER unsupported")
      return false
    }
    return try {
      WebViewCompat.addWebMessageListener(
        webView,
        NAME,
        ORIGINS,
        object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat?,
            sourceOrigin: android.net.Uri?,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy?,
          ) {
            handleMessage(replyProxy, message)
          }
        },
      )
      Log.i(TAG, "listener attached")
      true
    } catch (t: Throwable) {
      Log.w(TAG, "attach failed: ${t.message}")
      false
    }
  }

  private fun handleMessage(replyProxy: JavaScriptReplyProxy?, message: WebMessageCompat?) {
    if (replyProxy == null) return
    fun reply(bytes: ByteArray) {
      try {
        replyProxy.postMessage(bytes)
      } catch (_: Throwable) {
        // 応答不能時は上位の監視期限に任せる。
      }
    }
    try {
      val input = message?.arrayBuffer ?: return reply(ByteArray(0))
      reply(handleBatch(input) ?: ByteArray(0))
    } catch (_: Throwable) {
      reply(ByteArray(0))
    }
  }
}
