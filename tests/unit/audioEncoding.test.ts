import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  blobToBase64,
  getSupportedMimeType,
} from "../../src/components/Recorder/audioEncoding";

/**
 * `src/components/Recorder/audioEncoding.ts` の単体テスト。
 *
 * MediaRecorder はNode環境でテスト不可のため、Blob→base64変換など
 * ブラウザAPIに依存しない純粋ロジックの往復変換を検証する
 * （docs/design/frontend-design.md テスト方針節）。
 */
describe("audioEncoding", () => {
  describe("arrayBufferToBase64 / base64ToArrayBuffer", () => {
    it("ArrayBuffer → base64 → ArrayBuffer の往復で元のバイト列に一致する", () => {
      const original = new Uint8Array([0, 1, 2, 3, 255, 254, 128, 64]);
      const base64 = arrayBufferToBase64(original.buffer);
      const decoded = new Uint8Array(base64ToArrayBuffer(base64));

      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("空のArrayBufferは空文字列のbase64に変換される", () => {
      const empty = new Uint8Array([]);
      const base64 = arrayBufferToBase64(empty.buffer);
      expect(base64).toBe("");
    });

    it("CHUNK_SIZE(8192バイト)を超える大きいバッファでもコールスタック超過せず変換できる", () => {
      const size = 8192 * 3 + 123;
      const large = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        large[i] = i % 256;
      }

      const base64 = arrayBufferToBase64(large.buffer);
      const decoded = new Uint8Array(base64ToArrayBuffer(base64));

      expect(decoded.length).toBe(size);
      expect(Array.from(decoded)).toEqual(Array.from(large));
    });
  });

  describe("blobToBase64", () => {
    it("Blob を base64 に変換し、arrayBufferToBase64 と同じ結果になる", async () => {
      const bytes = new Uint8Array([10, 20, 30, 40, 50]);
      const blob = new Blob([bytes]);

      const base64FromBlob = await blobToBase64(blob);
      const base64FromBuffer = arrayBufferToBase64(bytes.buffer);

      expect(base64FromBlob).toBe(base64FromBuffer);
    });
  });

  describe("getSupportedMimeType", () => {
    it("Node環境（window未定義）では undefined を返す", () => {
      expect(getSupportedMimeType()).toBeUndefined();
    });
  });
});
