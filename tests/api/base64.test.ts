import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, base64UrlEncode } from "../../packages/api/base64";

describe("base64 codec", () => {
  it("encodes RFC vectors", () => {
    const enc = (s: string) => base64Encode(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg==");
    expect(enc("fo")).toBe("Zm8=");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg==");
    expect(enc("fooba")).toBe("Zm9vYmE=");
    expect(enc("foobar")).toBe("Zm9vYmFy");
  });

  it("round-trips all byte values and binary lengths incl. 0/1/2 mod 3", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    for (const len of [0, 1, 2, 3, 4, 5, 16, 100, 255, 256, 1024, 16412]) {
      const src = len <= 256 ? all.slice(0, len) : new Uint8Array(len).map((_, i) => i & 0xff);
      const dec = base64Decode(base64Encode(src));
      expect(dec.ok).toBe(true);
      if (dec.ok) expect([...dec.bytes]).toEqual([...src]);
    }
  });

  it("matches platform atob/btoa on random buffers", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    };
    for (const len of [7, 1000, 4096]) {
      const src = new Uint8Array(len);
      for (let i = 0; i < len; i++) src[i] = rand();
      const ours = base64Encode(src);
      const bin = String.fromCharCode(...src);
      expect(ours).toBe(btoa(bin));
      const dec = base64Decode(ours);
      expect(dec.ok).toBe(true);
    }
  });

  it("rejects malformed input", () => {
    expect(base64Decode("abc")).toEqual({ ok: false, error: "LENGTH" });
    expect(base64Decode("====")).toEqual({ ok: false, error: "CHARACTER" });
    expect(base64Decode("A===")).toEqual({ ok: false, error: "CHARACTER" });
    expect(base64Decode("AB=C")).toEqual({ ok: false, error: "CHARACTER" });
    expect(base64Decode("AB==CD==")).toEqual({ ok: false, error: "CHARACTER" });
    expect(base64Decode("Zm9*")).toEqual({ ok: false, error: "CHARACTER" });
    // padding位置のデータ文字・非ASCIIを拒否する。
    expect(base64Decode("Zm+η")).toEqual({ ok: false, error: "CHARACTER" });
    // 末尾のデータ文字は正当 (paddingなし)。
    expect(base64Decode("Zm9vYmEX")).toEqual({
      ok: true,
      bytes: new Uint8Array([102, 111, 111, 98, 97, 23]),
    });
    expect(base64Decode("Zm9v")).toEqual({
      ok: true,
      bytes: new Uint8Array([102, 111, 111]),
    });
  });

  it("base64UrlEncode avoids +/= for query transport", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
    expect(base64UrlEncode(new Uint8Array(0))).toBe("");
    // 復元可能性: 標準形へ戻してdecodeする。
    const src = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff);
    const url = base64UrlEncode(src);
    expect(url).not.toMatch(/[+/=]/);
    const std = url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    const dec = base64Decode(padded);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect([...dec.bytes]).toEqual([...src]);
  });
});
