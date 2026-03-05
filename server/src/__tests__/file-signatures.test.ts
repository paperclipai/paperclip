import { describe, expect, it } from "vitest";
import {
  detectImageContentTypeBySignature,
  normalizeDeclaredImageContentType,
} from "../security/file-signatures.js";

describe("file signature validation", () => {
  it("detects PNG signatures", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectImageContentTypeBySignature(png)).toBe("image/png");
  });

  it("detects JPEG signatures", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
    expect(detectImageContentTypeBySignature(jpeg)).toBe("image/jpeg");
  });

  it("normalizes MIME aliases", () => {
    expect(normalizeDeclaredImageContentType("image/jpg")).toBe("image/jpeg");
    expect(normalizeDeclaredImageContentType("image/pjpeg")).toBe("image/jpeg");
  });

  it("returns null for unsupported files", () => {
    expect(detectImageContentTypeBySignature(Buffer.from("hello"))).toBeNull();
    expect(normalizeDeclaredImageContentType("text/plain")).toBeNull();
  });
});
