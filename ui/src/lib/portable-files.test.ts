import { describe, expect, it } from "vitest";
import {
  getPortableFileText,
  getPortableFileContentType,
  getPortableFileDataUrl,
  isPortableImageFile,
} from "./portable-files.js";

// ============================================================================
// getPortableFileText
// ============================================================================

describe("getPortableFileText", () => {
  it("returns the string when entry is a string", () => {
    expect(getPortableFileText("hello world")).toBe("hello world");
  });

  it("returns null when entry is an object", () => {
    expect(getPortableFileText({ encoding: "base64", data: "base64", contentType: "image/png" })).toBeNull();
  });

  it("returns null for null entry", () => {
    expect(getPortableFileText(null)).toBeNull();
  });

  it("returns null for undefined entry", () => {
    expect(getPortableFileText(undefined)).toBeNull();
  });
});

// ============================================================================
// getPortableFileContentType
// ============================================================================

describe("getPortableFileContentType", () => {
  it("returns contentType from object entry when provided", () => {
    const entry = { encoding: "base64" as const, data: "abc", contentType: "image/gif" };
    expect(getPortableFileContentType("file.png", entry)).toBe("image/gif");
  });

  it("infers image/png from .png extension", () => {
    expect(getPortableFileContentType("photo.png", null)).toBe("image/png");
  });

  it("infers image/jpeg from .jpg extension", () => {
    expect(getPortableFileContentType("photo.jpg", null)).toBe("image/jpeg");
  });

  it("infers image/jpeg from .jpeg extension", () => {
    expect(getPortableFileContentType("photo.jpeg", null)).toBe("image/jpeg");
  });

  it("infers image/gif from .gif extension", () => {
    expect(getPortableFileContentType("anim.gif", null)).toBe("image/gif");
  });

  it("infers image/svg+xml from .svg extension", () => {
    expect(getPortableFileContentType("icon.svg", null)).toBe("image/svg+xml");
  });

  it("infers image/webp from .webp extension", () => {
    expect(getPortableFileContentType("photo.webp", null)).toBe("image/webp");
  });

  it("is case-insensitive for extension", () => {
    expect(getPortableFileContentType("photo.PNG", null)).toBe("image/png");
    expect(getPortableFileContentType("photo.JPG", null)).toBe("image/jpeg");
  });

  it("returns null for unknown extension", () => {
    expect(getPortableFileContentType("file.txt", null)).toBeNull();
  });

  it("returns null when no extension", () => {
    expect(getPortableFileContentType("noextension", null)).toBeNull();
  });
});

// ============================================================================
// getPortableFileDataUrl
// ============================================================================

describe("getPortableFileDataUrl", () => {
  it("returns a data URL for a binary entry", () => {
    const entry = { encoding: "base64" as const, data: "abc123==", contentType: "image/png" };
    const result = getPortableFileDataUrl("photo.png", entry);
    expect(result).toBe("data:image/png;base64,abc123==");
  });

  it("infers contentType from extension when not in entry object", () => {
    const entry = { encoding: "base64" as const, data: "xyz", contentType: "" };
    // contentType is empty string (falsy), falls through to extension inference
    const result = getPortableFileDataUrl("icon.svg", entry);
    expect(result).toContain("image/svg+xml");
  });

  it("uses application/octet-stream for unknown extension", () => {
    const entry = { encoding: "base64" as const, data: "xyz" };
    const result = getPortableFileDataUrl("archive.bin", entry);
    expect(result).toContain("application/octet-stream");
    expect(result).toContain("base64,xyz");
  });

  it("returns null for null entry", () => {
    expect(getPortableFileDataUrl("photo.png", null)).toBeNull();
  });

  it("returns null for string entry", () => {
    expect(getPortableFileDataUrl("readme.md", "text content")).toBeNull();
  });
});

// ============================================================================
// isPortableImageFile
// ============================================================================

describe("isPortableImageFile", () => {
  it("returns true for a .png file with null entry", () => {
    expect(isPortableImageFile("photo.png", null)).toBe(true);
  });

  it("returns true for an object entry with image contentType", () => {
    const entry = { encoding: "base64" as const, data: "abc", contentType: "image/webp" };
    expect(isPortableImageFile("file.bin", entry)).toBe(true);
  });

  it("returns false for a .txt file", () => {
    expect(isPortableImageFile("readme.txt", null)).toBe(false);
  });

  it("returns false for null entry with unknown extension", () => {
    expect(isPortableImageFile("archive.zip", null)).toBe(false);
  });

  it("infers from extension even for string entry", () => {
    // String entry doesn't override extension-based inference
    expect(isPortableImageFile("photo.png", "plain text")).toBe(true);
    expect(isPortableImageFile("readme.txt", "plain text")).toBe(false);
  });
});
