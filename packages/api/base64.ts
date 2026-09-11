/** 高速base64 (invoke-b64データプレーン用)。
 *
 * `Uint8Array.prototype.toBase64` への依存を避け (古いWebView対応)、
 * テーブル駆動の自前実装にする。パディングあり標準base64のみ。
 * decodeは不正文字・不正長を拒否し、成功時は所有権のある新規バッファを返す。
 */

const ENCODE_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const DECODE_TABLE: Int8Array = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < 64; i++) {
    t[ENCODE_TABLE.charCodeAt(i)] = i;
  }
  t["=".charCodeAt(0)] = -2; // padding marker
  return t;
})();

/** バイト列をbase64文字列へ。binary string化→native btoaの二段構え。
 * btoaは全WebView/Nodeで利用可能な枯れたAPI (新しい toBase64 とは別)。
 * fromCharCodeの引数長制限を避けてchunk化する。 */
export function base64Encode(src: Uint8Array): string {
  const n = src.length;
  if (n === 0) return "";
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < n; i += CHUNK) {
    // spread引数展開よりapplyの方がTypedArrayの実引数化が速い (実測約5倍)。
    bin += String.fromCharCode.apply(null, src.subarray(i, Math.min(i + CHUNK, n)) as unknown as number[]);
  }
  return btoa(bin);
}

export type Base64DecodeError = "LENGTH" | "CHARACTER";

/** バイト列をbase64url文字列へ (クエリ運搬用。パディングなし)。
 * Android WebViewはPOST bodyを配送しないためGETクエリで運ぶ。 */
export function base64UrlEncode(src: Uint8Array): string {
  return base64Encode(src).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64文字列をバイト列へ。不正時は {ok:false} (throwしない)。
 * '=' は末尾のパディング (0〜2文字) にのみ現れてよい。 */
export function base64Decode(
  s: string,
): { ok: true; bytes: Uint8Array } | { ok: false; error: Base64DecodeError } {
  const n = s.length;
  if (n === 0) return { ok: true, bytes: new Uint8Array(0) };
  if (n % 4 !== 0) return { ok: false, error: "LENGTH" };
  let pad = 0;
  if (s.charCodeAt(n - 1) === 61) pad = 1;
  if (pad === 1 && s.charCodeAt(n - 2) === 61) pad = 2;
  // パディング域より前に '=' があれば不正 (例 "AB==CD==")。
  for (let i = 0; i < n - pad; i++) {
    if (s.charCodeAt(i) === 61) return { ok: false, error: "CHARACTER" };
  }
  const out = new Uint8Array(((n / 4) | 0) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const last = i + 4 === n;
    // 最終quantumの有効文字数 (padding分を除く)。非最終は常に4。
    const want = last ? 4 - pad : 4;
    let triple = 0;
    for (let k = 0; k < want; k++) {
      const c = s.charCodeAt(i + k);
      const v = c < 256 ? DECODE_TABLE[c]! : -1;
      if (v < 0) return { ok: false, error: "CHARACTER" };
      triple |= v << ((3 - k) * 6);
    }
    if (want >= 2) out[o++] = (triple >> 16) & 0xff;
    if (want >= 3) out[o++] = (triple >> 8) & 0xff;
    if (want >= 4) out[o++] = triple & 0xff;
  }
  return { ok: true, bytes: out };
}
