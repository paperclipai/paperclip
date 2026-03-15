import { describe, it, expect } from "vitest";
import {
  inferContentTypeFromFilename,
  resolveContentType,
  isAllowedContentType,
  matchesContentType,
  parseAllowedTypes,
  DEFAULT_ALLOWED_TYPES,
} from "../attachment-types.js";

describe("attachment-types", () => {
  describe("inferContentTypeFromFilename", () => {
    it("infers text/markdown for .md files", () => {
      expect(inferContentTypeFromFilename("README.md")).toBe("text/markdown");
      expect(inferContentTypeFromFilename("notes.MD")).toBe("text/markdown");
    });

    it("infers text/markdown for .markdown files", () => {
      expect(inferContentTypeFromFilename("file.markdown")).toBe("text/markdown");
    });

    it("infers text/plain for .txt files", () => {
      expect(inferContentTypeFromFilename("notes.txt")).toBe("text/plain");
    });

    it("infers application/json for .json files", () => {
      expect(inferContentTypeFromFilename("config.json")).toBe("application/json");
    });

    it("infers image types correctly", () => {
      expect(inferContentTypeFromFilename("photo.png")).toBe("image/png");
      expect(inferContentTypeFromFilename("photo.jpg")).toBe("image/jpeg");
      expect(inferContentTypeFromFilename("photo.jpeg")).toBe("image/jpeg");
      expect(inferContentTypeFromFilename("photo.gif")).toBe("image/gif");
      expect(inferContentTypeFromFilename("photo.webp")).toBe("image/webp");
    });

    it("returns undefined for unknown extensions", () => {
      expect(inferContentTypeFromFilename("file.xyz")).toBeUndefined();
      expect(inferContentTypeFromFilename("file")).toBeUndefined();
    });

    it("handles null and undefined filenames", () => {
      expect(inferContentTypeFromFilename(null)).toBeUndefined();
      expect(inferContentTypeFromFilename(undefined)).toBeUndefined();
    });
  });

  describe("resolveContentType", () => {
    it("uses reported mimetype when valid", () => {
      expect(resolveContentType("text/plain", "file.md")).toBe("text/plain");
      expect(resolveContentType("image/png", "file.jpg")).toBe("image/png");
    });

    it("infers from filename when mimetype is octet-stream", () => {
      expect(resolveContentType("application/octet-stream", "README.md")).toBe("text/markdown");
      expect(resolveContentType("application/octet-stream", "data.json")).toBe("application/json");
    });

    it("infers from filename when mimetype is empty", () => {
      expect(resolveContentType("", "notes.txt")).toBe("text/plain");
      expect(resolveContentType(undefined, "photo.png")).toBe("image/png");
    });

    it("falls back to octet-stream when cannot infer", () => {
      expect(resolveContentType("application/octet-stream", "file.xyz")).toBe("application/octet-stream");
      expect(resolveContentType("", "unknown")).toBe("application/octet-stream");
    });
  });

  describe("isAllowedContentType", () => {
    it("allows default types", () => {
      expect(isAllowedContentType("image/png")).toBe(true);
      expect(isAllowedContentType("text/markdown")).toBe(true);
      expect(isAllowedContentType("application/pdf")).toBe(true);
    });

    it("rejects unknown types", () => {
      expect(isAllowedContentType("application/x-custom")).toBe(false);
    });
  });

  describe("matchesContentType", () => {
    it("matches exact types", () => {
      expect(matchesContentType("image/png", ["image/png"])).toBe(true);
      expect(matchesContentType("image/png", ["image/jpeg"])).toBe(false);
    });

    it("matches wildcard patterns", () => {
      expect(matchesContentType("image/png", ["image/*"])).toBe(true);
      expect(matchesContentType("image/jpeg", ["image/*"])).toBe(true);
      expect(matchesContentType("text/plain", ["image/*"])).toBe(false);
    });

    it("matches * wildcard", () => {
      expect(matchesContentType("anything/goes", ["*"])).toBe(true);
    });
  });

  describe("parseAllowedTypes", () => {
    it("returns defaults for empty input", () => {
      expect(parseAllowedTypes(undefined)).toEqual([...DEFAULT_ALLOWED_TYPES]);
      expect(parseAllowedTypes("")).toEqual([...DEFAULT_ALLOWED_TYPES]);
    });

    it("parses comma-separated list", () => {
      expect(parseAllowedTypes("image/*,application/pdf")).toEqual(["image/*", "application/pdf"]);
    });

    it("trims whitespace", () => {
      expect(parseAllowedTypes(" image/* , application/pdf ")).toEqual(["image/*", "application/pdf"]);
    });
  });
});
