package dev.example.commoncorepoc

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // WebMessageChannel受け口 (gen再生成時はこの2箇所を再適用する)。
    CorebinPort.attachToContentView(this)
  }

  override fun onResume() {
    super.onResume()
    // WebView生成がonCreateより遅い場合の再試行 (付与済みなら何もしない)。
    CorebinPort.attachToContentView(this)
  }
}
