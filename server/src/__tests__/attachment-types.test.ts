import { describe, it, expect } from "vitest";
import {
  canBufferForUtf8Validation,
  DEFAULT_ALLOWED_TYPES,
  formatAttachmentSize,
  INLINE_ATTACHMENT_TYPES,
  inferOfficeAttachmentContentTypeFromFilename,
  isInlineAttachmentContentType,
  isTextualAttachmentContentType,
  isValidUtf8Buffer,
  matchesContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  parseAllowedTypes,
  withUtf8CharsetIfTextual,
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

  it("allows common chat audio types by default", () => {
    for (const contentType of [
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
    ]) {
      expect(matchesContentType(contentType, [...DEFAULT_ALLOWED_TYPES])).toBe(
        true,
      );
    }
  });
});

describe("normalizeContentType", () => {
  it("lowercases and trims explicit types", () => {
    expect(normalizeContentType(" Application/Zip ")).toBe("application/zip");
  });

  it("normalizes provider Content-Type header parameters to the MIME essence", () => {
    expect(normalizeContentType(" Text/Plain ; charset=utf-8 ")).toBe(
      "text/plain",
    );
    expect(normalizeContentType("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml",
    );
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

describe("withUtf8CharsetIfTextual", () => {
  it("adds charset=utf-8 to text/* types", () => {
    expect(withUtf8CharsetIfTextual("text/markdown")).toBe("text/markdown; charset=utf-8");
    expect(withUtf8CharsetIfTextual("text/plain")).toBe("text/plain; charset=utf-8");
    expect(withUtf8CharsetIfTextual("text/csv")).toBe("text/csv; charset=utf-8");
    expect(withUtf8CharsetIfTextual("text/html")).toBe("text/html; charset=utf-8");
  });

  it("adds charset=utf-8 to application/json and *+json types", () => {
    expect(withUtf8CharsetIfTextual("application/json")).toBe("application/json; charset=utf-8");
    expect(withUtf8CharsetIfTextual("application/ld+json")).toBe("application/ld+json; charset=utf-8");
  });

  it("is case-insensitive when matching the base type", () => {
    expect(withUtf8CharsetIfTextual("Text/Markdown")).toBe("Text/Markdown; charset=utf-8");
  });

  it("preserves an existing charset instead of duplicating it", () => {
    expect(withUtf8CharsetIfTextual("text/plain; charset=iso-8859-1")).toBe(
      "text/plain; charset=iso-8859-1",
    );
    expect(withUtf8CharsetIfTextual("text/markdown; charset=utf-8")).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("leaves binary/media content types unchanged", () => {
    for (const contentType of [
      "application/pdf",
      "application/zip",
      "image/png",
      "video/mp4",
      "application/octet-stream",
    ]) {
      expect(withUtf8CharsetIfTextual(contentType)).toBe(contentType);
    }
  });

  it("handles empty or missing input", () => {
    expect(withUtf8CharsetIfTextual(undefined)).toBe("");
    expect(withUtf8CharsetIfTextual(null)).toBe("");
    expect(withUtf8CharsetIfTextual("")).toBe("");
  });

  it("leaves textual content types unlabeled when the bytes are not confirmed UTF-8", () => {
    expect(withUtf8CharsetIfTextual("text/plain", { validatedUtf8: false })).toBe("text/plain");
    expect(withUtf8CharsetIfTextual("application/json", { validatedUtf8: false })).toBe("application/json");
  });

  it("still leaves binary content types unchanged regardless of validatedUtf8", () => {
    expect(withUtf8CharsetIfTextual("application/pdf", { validatedUtf8: false })).toBe("application/pdf");
    expect(withUtf8CharsetIfTextual("image/png", { validatedUtf8: true })).toBe("image/png");
  });
});

describe("isTextualAttachmentContentType", () => {
  it("identifies text/*, application/json, and *+json as textual", () => {
    expect(isTextualAttachmentContentType("text/plain")).toBe(true);
    expect(isTextualAttachmentContentType("text/markdown; charset=utf-8")).toBe(true);
    expect(isTextualAttachmentContentType("application/json")).toBe(true);
    expect(isTextualAttachmentContentType("application/ld+json")).toBe(true);
  });

  it("does not treat binary/media types as textual", () => {
    for (const contentType of ["application/pdf", "application/zip", "image/png", "video/mp4"]) {
      expect(isTextualAttachmentContentType(contentType)).toBe(false);
    }
  });

  it("handles empty or missing input", () => {
    expect(isTextualAttachmentContentType(undefined)).toBe(false);
    expect(isTextualAttachmentContentType(null)).toBe(false);
    expect(isTextualAttachmentContentType("")).toBe(false);
  });
});

describe("isValidUtf8Buffer", () => {
  it("accepts valid UTF-8 including multi-byte characters", () => {
    expect(isValidUtf8Buffer(Buffer.from("hello world"))).toBe(true);
    expect(isValidUtf8Buffer(Buffer.from("café 日本語", "utf8"))).toBe(true);
  });

  it("rejects bytes that are not well-formed UTF-8", () => {
    // 0xE9 is "é" in Latin-1/Windows-1252 but is an invalid standalone UTF-8 byte.
    const latin1Bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(isValidUtf8Buffer(latin1Bytes)).toBe(false);
  });

  it("treats an empty buffer as valid", () => {
    expect(isValidUtf8Buffer(Buffer.alloc(0))).toBe(true);
  });

  it("does not treat structurally-valid-but-ambiguous Windows-1252 bytes as confident UTF-8", () => {
    // 0xC2 0xA9 is well-formed UTF-8 for the single character "(c)" (U+00A9),
    // but the very same two bytes are also well-formed Windows-1252/Latin-1
    // for two separate characters ("A" + "(c)"). Structural validity alone
    // can't tell those apart, so this must not be treated as confirmed UTF-8.
    const windows1252Bytes = Buffer.from([0xc2, 0xa9]);
    expect(isValidUtf8Buffer(windows1252Bytes)).toBe(false);
  });

  it("does not treat lone Latin-1 Supplement characters as confident UTF-8 without stronger evidence", () => {
    // "cafe" + U+00E9 alone only produces ambiguous Latin-1 Supplement bytes
    // (0xC3 0xA9), which collide with valid Windows-1252 text the same way
    // as the case above, so it is not confirmed UTF-8 on its own.
    expect(isValidUtf8Buffer(Buffer.from("cafeé", "utf8"))).toBe(false);
  });

  it("treats a lone ambiguous character as confident UTF-8 once at least one more non-ASCII code point is also present", () => {
    // A single ambiguous character plus CJK characters (3-byte UTF-8
    // sequences) reaches the two-code-point threshold, so the whole buffer
    // is trusted, including the earlier ambiguous character.
    expect(isValidUtf8Buffer(Buffer.from("cafeé 日本語", "utf8"))).toBe(true);
  });

  it("does not treat a single 3-byte sequence beyond U+00FF as confident UTF-8 on its own", () => {
    // 0xE2 0x82 0xAC is the UTF-8 encoding of "€" (U+20AC), but the same
    // three bytes are also well-formed Windows-1252 for "â‚¬" - three
    // unrelated legacy characters. A lone multi-byte coincidence, however
    // many bytes it spans, isn't reliable evidence of the source encoding.
    const euroSignBytes = Buffer.from([0xe2, 0x82, 0xac]);
    expect(isValidUtf8Buffer(euroSignBytes)).toBe(false);
  });

  it("does not treat a repeated identical code point as confident UTF-8", () => {
    // "€€" is two repeats of the *same* code point (U+20AC), which is also
    // what a legacy Windows-1252 document with the same repeated digraph
    // would decode to. Repetition of an identical code point isn't
    // independent evidence, so this must not be trusted.
    expect(isValidUtf8Buffer(Buffer.from("€€", "utf8"))).toBe(false);
  });

  it("treats two distinct code points beyond U+00FF as confident UTF-8", () => {
    // Two distinct multi-byte sequences ("€" and "£") coincidentally forming
    // well-formed UTF-8 out of legacy single-byte text is negligibly
    // unlikely, so this is trusted even though each individually would not
    // be.
    expect(isValidUtf8Buffer(Buffer.from("€£", "utf8"))).toBe(true);
  });
});

describe("canBufferForUtf8Validation", () => {
  it("allows sizes at or below the attachment max-bytes cap", () => {
    expect(canBufferForUtf8Validation(0)).toBe(true);
    expect(canBufferForUtf8Validation(1024)).toBe(true);
    expect(canBufferForUtf8Validation(MAX_ATTACHMENT_BYTES)).toBe(true);
  });

  it("rejects sizes above the attachment max-bytes cap", () => {
    expect(canBufferForUtf8Validation(MAX_ATTACHMENT_BYTES + 1)).toBe(false);
    expect(canBufferForUtf8Validation(MAX_ATTACHMENT_BYTES * 100)).toBe(false);
  });

  it("rejects unknown or invalid sizes so unbounded streams are never buffered", () => {
    expect(canBufferForUtf8Validation(null)).toBe(false);
    expect(canBufferForUtf8Validation(undefined)).toBe(false);
    expect(canBufferForUtf8Validation(Number.NaN)).toBe(false);
    expect(canBufferForUtf8Validation(-1)).toBe(false);
  });
});

describe("formatAttachmentSize", () => {
  it("renders the default deployment cap as a round megabyte figure", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(formatAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe("10 MB");
  });

  it("keeps one decimal place for fractional sizes and drops a trailing .0", () => {
    expect(formatAttachmentSize(10.5 * 1024 * 1024)).toBe("10.5 MB");
    expect(formatAttachmentSize(1024 * 1024)).toBe("1 MB");
    expect(formatAttachmentSize(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });

  it("renders sub-megabyte values in kilobytes", () => {
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(512 * 1024)).toBe("512 KB");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
  });

  it("steps up to gigabytes for very large caps", () => {
    expect(formatAttachmentSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");
  });

  it("keeps sub-kilobyte values in bytes rather than collapsing to 0 KB", () => {
    expect(formatAttachmentSize(10)).toBe("10 bytes");
    expect(formatAttachmentSize(1)).toBe("1 byte");
    expect(formatAttachmentSize(1023)).toBe("1023 bytes");
  });

  it("never renders a nonsense figure for a degenerate input", () => {
    expect(formatAttachmentSize(0)).toBe("0 bytes");
    expect(formatAttachmentSize(-1)).toBe("0 bytes");
    expect(formatAttachmentSize(Number.NaN)).toBe("0 bytes");
  });
});
