import { describe, expect, it } from "vitest";

import { contentDispositionFilename } from "../lib/content-disposition.js";

describe("contentDispositionFilename", () => {
  it("emits only the canonical filename= form for a plain ASCII name", () => {
    const value = contentDispositionFilename("report.pdf");
    expect(value).toBe('filename="report.pdf"');
  });

  it("encodes a Korean filename via RFC 5987 with an ASCII fallback", () => {
    const value = contentDispositionFilename("한글.pdf");
    // ASCII fallback collapses each non-ASCII codepoint to `_`.
    expect(value).toContain('filename="__.pdf"');
    // RFC 5987 ext-value is UTF-8 percent-encoded (한 => %ED%95%9C).
    expect(value).toContain("filename*=UTF-8''%ED%95%9C%EA%B8%80.pdf");
  });

  it("handles Japanese, Chinese, Arabic, and emoji names", () => {
    for (const name of ["メモ.txt", "文件.txt", "ملف.txt", "📎clip.png"]) {
      const value = contentDispositionFilename(name);
      expect(value).toMatch(/^filename="[\x20-\x7E]*"; filename\*=UTF-8''/);
      // The fallback must contain only printable ASCII.
      const fallback = value.match(/^filename="([^"]*)"/)?.[1] ?? "";
      expect(fallback).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it("strips quotes and backslashes from the ASCII fallback so the quoted-string is safe", () => {
    const value = contentDispositionFilename('a"b\\c.txt');
    expect(value).toContain('filename="abc.txt"');
  });

  it("percent-encodes RFC 5987 attr-char exceptions left raw by encodeURIComponent", () => {
    // A non-ASCII codepoint forces the filename* form; the ASCII attr-char exceptions that
    // ride along must still be percent-encoded, never left literal in the ext-value.
    const value = contentDispositionFilename("한'(c)*!.txt");
    const extValue = value.split("filename*=UTF-8''")[1];
    // None of ' ( ) * ! may appear literally in the ext-value.
    expect(extValue).not.toMatch(/['()*!]/);
    expect(extValue).toContain("%27"); // '
    expect(extValue).toContain("%28"); // (
    expect(extValue).toContain("%2A"); // *
  });
});
