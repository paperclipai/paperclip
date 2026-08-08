import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_TYPES,
  INLINE_ATTACHMENT_TYPES,
  inferOfficeAttachmentContentTypeFromFilename,
  isInlineAttachmentContentType,
  matchesContentType,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  parseAllowedTypes,
  readStreamWithByteCap,
  truncateUtf8ToByteLimit,
} from "../attachment-types.js";

describe("parseAllowedTypes", () => {
  it("returns default image types when input is undefined", () => {
    expect(parseAllowedTypes(undefined)).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("returns default image types when input is empty string", () => {
    expect(parseAllowedTypes("")).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("parses comma-separated types", () => {
    expect(parseAllowedTypes("image/*,application/pdf")).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseAllowedTypes(" image/png , application/pdf ")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });

  it("lowercases entries", () => {
    expect(parseAllowedTypes("Application/PDF")).toEqual(["application/pdf"]);
  });

  it("filters empty segments", () => {
    expect(parseAllowedTypes("image/png,,application/pdf,")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });
});

describe("matchesContentType", () => {
  it("matches exact types", () => {
    const patterns = ["application/pdf", "image/png"];
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(false);
  });

  it("matches /* wildcard patterns", () => {
    const patterns = ["image/*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("image/jpeg", patterns)).toBe(true);
    expect(matchesContentType("image/svg+xml", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("matches .* wildcard patterns", () => {
    const patterns = ["application/vnd.openxmlformats-officedocument.*"];
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        patterns,
      ),
    ).toBe(true);
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        patterns,
      ),
    ).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("is case-insensitive", () => {
    const patterns = ["application/pdf"];
    expect(matchesContentType("APPLICATION/PDF", patterns)).toBe(true);
    expect(matchesContentType("Application/Pdf", patterns)).toBe(true);
  });

  it("combines exact and wildcard patterns", () => {
    const patterns = ["image/*", "application/pdf", "text/*"];
    expect(matchesContentType("image/webp", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/csv", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(false);
  });

  it("handles plain * as allow-all wildcard", () => {
    const patterns = ["*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(true);
  });

  it("allows common Office document types by default", () => {
    for (const contentType of [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(matchesContentType(contentType, [...DEFAULT_ALLOWED_TYPES])).toBe(true);
    }
  });
});

describe("normalizeContentType", () => {
  it("lowercases and trims explicit types", () => {
    expect(normalizeContentType(" Application/Zip ")).toBe("application/zip");
  });

  it("falls back to octet-stream when the type is missing", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
  });
});

describe("inferOfficeAttachmentContentTypeFromFilename", () => {
  it("infers common Office content types from filenames", () => {
    expect(inferOfficeAttachmentContentTypeFromFilename("notes.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("raw-data.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.doc")).toBe("application/msword");
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.xls")).toBe("application/vnd.ms-excel");
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.ppt")).toBe("application/vnd.ms-powerpoint");
  });

  it("does not infer unknown extensions", () => {
    expect(inferOfficeAttachmentContentTypeFromFilename("payload.bin")).toBeNull();
    expect(inferOfficeAttachmentContentTypeFromFilename(undefined)).toBeNull();
  });
});

describe("normalizeUploadAttachmentContentType", () => {
  it("keeps explicit content types unchanged", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/pdf",
        originalFilename: "raw-data.xlsx",
      }),
    ).toBe("application/pdf");
  });

  it("infers Office content type for generic binary uploads", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "raw-data.xlsx",
      }),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("keeps generic binary uploads generic when the inferred Office type is not allowed", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "raw-data.xlsx",
        isAllowedContentType: (contentType) => contentType === "application/octet-stream",
      }),
    ).toBe("application/octet-stream");
  });

  it("keeps generic binary uploads generic for unknown filenames", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "payload.bin",
      }),
    ).toBe("application/octet-stream");
  });
});

describe("isInlineAttachmentContentType", () => {
  it("allows the configured inline-safe types", () => {
    for (const contentType of ["image/png", "image/svg+xml", "application/pdf", "text/plain", "video/mp4"]) {
      expect(isInlineAttachmentContentType(contentType)).toBe(true);
    }
  });

  it("rejects potentially unsafe or binary download types", () => {
    expect(INLINE_ATTACHMENT_TYPES).not.toContain("text/html");
    expect(isInlineAttachmentContentType("text/html")).toBe(false);
    expect(isInlineAttachmentContentType("application/zip")).toBe(false);
  });
});

describe("truncateUtf8ToByteLimit", () => {
  it("returns the body unchanged when within the byte budget", () => {
    expect(truncateUtf8ToByteLimit("hello", 64)).toEqual({ body: "hello", truncated: false });
  });

  it("measures in UTF-8 bytes, not characters", () => {
    // "€" is 3 UTF-8 bytes; 3 of them = 9 bytes but only 3 characters.
    const body = "€€€";
    expect(body.length).toBe(3);
    const result = truncateUtf8ToByteLimit(body, 4);
    expect(result.truncated).toBe(true);
    // Must not split a multi-byte character mid-sequence.
    expect(result.body).toBe("€");
    expect(Buffer.byteLength(result.body, "utf-8")).toBeLessThanOrEqual(4);
    expect(result.body).not.toContain("�");
  });

  it("does not truncate when the body exactly fills the budget", () => {
    const body = "€€"; // 6 bytes
    expect(truncateUtf8ToByteLimit(body, 6)).toEqual({ body, truncated: false });
  });
});

describe("readStreamWithByteCap", () => {
  async function* chunks(...parts: Array<string | Uint8Array>) {
    for (const p of parts) {
      yield typeof p === "string" ? Buffer.from(p, "utf-8") : p;
    }
  }

  it("returns the concatenated buffer when total size is within the cap", async () => {
    const result = await readStreamWithByteCap(chunks("ab", "cd"), 64);
    expect(result.truncated).toBe(false);
    expect(result.buffer?.toString("utf-8")).toBe("abcd");
  });

  it("skips inlining (null buffer) when the stream exceeds the cap", async () => {
    // 8 bytes streamed against a 4-byte cap: the stored object is larger than
    // its recorded size, so it must not be buffered into memory.
    const result = await readStreamWithByteCap(chunks("aaaa", "bbbb"), 4);
    expect(result.truncated).toBe(true);
    expect(result.buffer).toBeNull();
  });

  it("accepts a stream exactly at the cap", async () => {
    const result = await readStreamWithByteCap(chunks("aa", "bb"), 4);
    expect(result.truncated).toBe(false);
    expect(result.buffer?.toString("utf-8")).toBe("aabb");
  });
});
