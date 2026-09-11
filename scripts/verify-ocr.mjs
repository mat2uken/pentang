#!/usr/bin/env node
// verify-ocr — screenshot OCR結果の共通pure helper。
// device/simのverify scriptから使う。DOM・adb・swiftに依存しない。

/** OCR boxes text ("string\tx\ty\tw\th" per line, Vision bottom-left origin)
 *  から needle を含む行を探し、中心の正規化座標 (top-left origin) を返す。 */
export function findBox(boxesText, needle) {
  const lines = boxesText.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const s = parts[0];
    if (s.includes(needle)) {
      const x = Number(parts[1]), y = Number(parts[2]), w = Number(parts[3]), h = Number(parts[4]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        // Vision bottom-left -> top-left normalized: nx = x + w/2, ny = (1 - y - h/2)
        const nx = x + w / 2;
        const ny = 1 - y - h / 2;
        return { text: s, nx, ny };
      }
    }
  }
  return null;
}

/** self-test既定値 (multiplier=2, offset=1 の checksum=15・values 3,5,7) の有無。 */
export function hasExpectedResult(text) {
  const compact = String(text ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，、]/g, ",");
  return /checksum=15(?:$|[^\d])/.test(compact) && /(?:^|[^\d])3,5,7(?:$|[^\d])/.test(compact);
}
