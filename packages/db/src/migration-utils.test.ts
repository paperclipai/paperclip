import { describe, expect, it } from "vitest";
import { normalizeMigrationContent } from "./migration-utils.js";

describe("normalizeMigrationContent", () => {
  it("passes LF content through unchanged", () => {
    const input = "CREATE TABLE foo (\n  id SERIAL PRIMARY KEY\n);\n";
    expect(normalizeMigrationContent(input)).toBe(input);
  });

  it("normalizes CRLF content to LF", () => {
    const input = "CREATE TABLE foo (\r\n  id SERIAL PRIMARY KEY\r\n);\r\n";
    const expected = "CREATE TABLE foo (\n  id SERIAL PRIMARY KEY\n);\n";
    expect(normalizeMigrationContent(input)).toBe(expected);
  });

  it("normalizes mixed line endings (some CRLF, some LF) to LF", () => {
    const input = "line one\r\nline two\nline three\r\nline four\n";
    const expected = "line one\nline two\nline three\nline four\n";
    expect(normalizeMigrationContent(input)).toBe(expected);
  });

  it("returns empty string for empty content", () => {
    expect(normalizeMigrationContent("")).toBe("");
  });
});
