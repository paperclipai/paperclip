import { describe, it, expect } from "vitest";
import {
  parseAllowedTypes,
  matchesContentType,
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
