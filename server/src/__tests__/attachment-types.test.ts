import { describe, it, expect } from "vitest";
import {
  parseAllowedTypes,
  matchesContentType,
  inferContentType,
  DEFAULT_ALLOWED_TYPES,
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
});

describe("inferContentType", () => {
  it("returns original mime type when not application/octet-stream", () => {
    expect(inferContentType("test.md", "text/markdown")).toBe("text/markdown");
    expect(inferContentType("test.png", "image/png")).toBe("image/png");
  });

  it("infers text/markdown from .md extension", () => {
    expect(inferContentType("readme.md", "application/octet-stream")).toBe("text/markdown");
    expect(inferContentType("README.MD", "application/octet-stream")).toBe("text/markdown");
    expect(inferContentType("docs/guide.md", "application/octet-stream")).toBe("text/markdown");
  });

  it("infers text/markdown from .markdown extension", () => {
    expect(inferContentType("readme.markdown", "application/octet-stream")).toBe("text/markdown");
  });

  it("infers text/plain from .txt extension", () => {
    expect(inferContentType("notes.txt", "application/octet-stream")).toBe("text/plain");
  });

  it("infers application/json from .json extension", () => {
    expect(inferContentType("data.json", "application/octet-stream")).toBe("application/json");
  });

  it("returns original mime type for unknown extensions", () => {
    expect(inferContentType("file.xyz", "application/octet-stream")).toBe("application/octet-stream");
    expect(inferContentType("file.unknown", "application/octet-stream")).toBe("application/octet-stream");
  });

  it("returns original mime type when filename is null or undefined", () => {
    expect(inferContentType(null, "application/octet-stream")).toBe("application/octet-stream");
    expect(inferContentType(undefined, "application/octet-stream")).toBe("application/octet-stream");
    expect(inferContentType("", "application/octet-stream")).toBe("application/octet-stream");
  });

  it("returns original mime type for filenames with no extension", () => {
    expect(inferContentType("nodotfile", "application/octet-stream")).toBe("application/octet-stream");
    expect(inferContentType("Makefile", "application/octet-stream")).toBe("application/octet-stream");
    expect(inferContentType("README", "application/octet-stream")).toBe("application/octet-stream");
  });
});
