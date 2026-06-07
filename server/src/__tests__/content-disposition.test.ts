import { describe, expect, it } from "vitest";

import { buildContentDisposition } from "../lib/content-disposition.js";

const LATIN1_SAFE = /^[\x00-\xff]*$/;

describe("buildContentDisposition", () => {
  it("leaves a plain ASCII filename untouched and omits filename*", () => {
    expect(buildContentDisposition("attachment", "report.pdf")).toBe(
      'attachment; filename="report.pdf"',
    );
  });

  it("appends an RFC 5987 filename* for non-ASCII (Korean) filenames", () => {
    const value = buildContentDisposition("attachment", "사업자등록증.xlsx");
    expect(value).toBe(
      "attachment; filename=\"______.xlsx\"; filename*=UTF-8''%EC%82%AC%EC%97%85%EC%9E%90%EB%93%B1%EB%A1%9D%EC%A6%9D.xlsx",
    );
    // The whole header must be Latin-1 safe so res.setHeader never throws
    // ERR_INVALID_CHAR (the root cause of the attachment-download 500).
    expect(LATIN1_SAFE.test(value)).toBe(true);
  });

  it("honours the inline disposition", () => {
    expect(buildContentDisposition("inline", "사진.png")).toBe(
      "inline; filename=\"__.png\"; filename*=UTF-8''%EC%82%AC%EC%A7%84.png",
    );
  });

  it("strips quotes from the ASCII fallback and preserves them in filename*", () => {
    const value = buildContentDisposition("attachment", 'in"voice.pdf');
    expect(value).toBe(
      "attachment; filename=\"invoice.pdf\"; filename*=UTF-8''in%22voice.pdf",
    );
  });

  it("percent-encodes characters that are not valid RFC 5987 attr-chars", () => {
    // The fallback can represent ASCII `'()*` verbatim inside the quoted
    // string, but once a non-ASCII byte forces a filename*, those characters
    // must be percent-encoded because they are not valid RFC 5987 attr-chars.
    const value = buildContentDisposition("attachment", "café(1)'*.txt");
    expect(value).toContain("filename*=UTF-8''caf%C3%A9%281%29%27%2A.txt");
  });

  it("keeps an all-ASCII name with special characters in the quoted fallback", () => {
    expect(buildContentDisposition("attachment", "a'b(c)*.txt")).toBe(
      "attachment; filename=\"a'b(c)*.txt\"",
    );
  });

  it("falls back to a default name when no printable ASCII remains", () => {
    // Only quote/backslash characters: stripped from the fallback, leaving it
    // empty, so the default name is used while filename* preserves the bytes.
    const value = buildContentDisposition("attachment", '"\\"');
    expect(value).toBe(
      "attachment; filename=\"download\"; filename*=UTF-8''%22%5C%22",
    );
  });

  it("falls back to a default name for empty or nullish filenames", () => {
    expect(buildContentDisposition("attachment", "")).toBe(
      'attachment; filename="download"',
    );
    expect(buildContentDisposition("attachment", null)).toBe(
      'attachment; filename="download"',
    );
    expect(buildContentDisposition("attachment", undefined)).toBe(
      'attachment; filename="download"',
    );
  });

  it("produces Latin-1 safe output for a range of non-ASCII scripts", () => {
    for (const name of ["café.txt", "naïve.doc", "日本語.zip", "Ω.csv", "🎉.gif"]) {
      expect(LATIN1_SAFE.test(buildContentDisposition("attachment", name))).toBe(
        true,
      );
    }
  });
});
