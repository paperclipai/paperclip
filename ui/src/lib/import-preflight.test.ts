// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  INLINE_IMPORT_MAX_BYTES,
  REQUEST_ENVELOPE_ALLOWANCE_BYTES,
  buildInlineImportPreflight,
  estimateInlineImportBytes,
  isBlobStoreFilePath,
  stripBlobFiles,
} from "./import-preflight";

const megabyte = 1024 * 1024;

describe("import preflight", () => {
  it("recognizes blob store paths at the package root only", () => {
    expect(isBlobStoreFilePath("blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStoreFilePath("paperclip-demo/blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStoreFilePath("tasks/pap-1/TASK.md")).toBe(false);
    expect(isBlobStoreFilePath("blobs/nested/file")).toBe(false);
  });

  it("estimates inline bytes from JSON-escaped text, base64 entries, keys, and the envelope", () => {
    const base = estimateInlineImportBytes({});
    expect(base).toBe(REQUEST_ENVELOPE_ALLOWANCE_BYTES);
    // "COMPANY.md" key = 12 serialized bytes + 2 separators; "12345" = 7 with quotes.
    expect(estimateInlineImportBytes({ "COMPANY.md": "12345" }) - base).toBe(12 + 2 + 7);
    // Base64 entries count their object structure and contentType, not just the payload.
    expect(estimateInlineImportBytes({
      "blobs/abc": { encoding: "base64", data: "QUJDRA==", contentType: "application/octet-stream" },
    }) - base).toBe(11 + 2 + (48 + 8 + 24));
  });

  it("counts UTF-8 bytes of serialized text, not UTF-16 code units", () => {
    const base = estimateInlineImportBytes({});
    // Two CJK characters: String.length is 2, but each is 3 bytes of UTF-8,
    // plus the surrounding JSON quotes the request body will carry.
    expect(estimateInlineImportBytes({ "COMPANY.md": "汉字" }) - base).toBe(12 + 2 + 8);
    // A newline serializes as the two-character escape sequence \n.
    expect(estimateInlineImportBytes({ "NOTES.md": "a\nb" }) - base).toBe(10 + 2 + 6);
  });

  it("counts file-path keys so path-heavy packages cannot undercount", () => {
    const shortKey = estimateInlineImportBytes({ B: "x" });
    const longKey = estimateInlineImportBytes({ ["A".repeat(100)]: "x" });
    expect(longKey - shortKey).toBe(99);
  });

  it("never estimates below the actual serialized files map", () => {
    const files = {
      "COMPANY.md": '汉字 with\nnewlines and "quotes"',
      "tasks/pap-1/TASK.md": "plain text",
      "blobs/abc": { encoding: "base64" as const, data: "QUJDRA==", contentType: "image/png" },
    };
    const serialized = new TextEncoder().encode(JSON.stringify(files)).length;
    expect(estimateInlineImportBytes(files)).toBeGreaterThanOrEqual(serialized);
  });

  it("passes packages under the inline limit", () => {
    const preflight = buildInlineImportPreflight({ "COMPANY.md": "x".repeat(megabyte) });
    expect(preflight.tooLarge).toBe(false);
    expect(preflight.canDropAttachments).toBe(false);
  });

  it("blocks oversized packages and offers to drop attachments when that fits", () => {
    const preflight = buildInlineImportPreflight({
      "COMPANY.md": "x".repeat(megabyte),
      "blobs/abc": {
        encoding: "base64",
        data: "A".repeat(INLINE_IMPORT_MAX_BYTES),
        contentType: "application/octet-stream",
      },
    });
    expect(preflight.tooLarge).toBe(true);
    expect(preflight.canDropAttachments).toBe(true);
  });

  it("blocks oversized packages without the attachment escape hatch when text alone is too big", () => {
    const preflight = buildInlineImportPreflight({
      "COMPANY.md": "x".repeat(INLINE_IMPORT_MAX_BYTES + 1),
    });
    expect(preflight.tooLarge).toBe(true);
    expect(preflight.canDropAttachments).toBe(false);
  });

  it("strips only blob files from the package", () => {
    expect(stripBlobFiles({
      "COMPANY.md": "text",
      "blobs/abc": { encoding: "base64", data: "QQ==", contentType: "application/octet-stream" },
    })).toEqual({ "COMPANY.md": "text" });
  });
});
