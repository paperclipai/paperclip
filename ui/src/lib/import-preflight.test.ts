// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  INLINE_IMPORT_MAX_BYTES,
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

  it("estimates inline bytes from text lengths and base64 payload lengths", () => {
    expect(estimateInlineImportBytes({
      "COMPANY.md": "12345",
      "blobs/abc": { encoding: "base64", data: "QUJDRA==", contentType: "application/octet-stream" },
    })).toBe(5 + 8);
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
