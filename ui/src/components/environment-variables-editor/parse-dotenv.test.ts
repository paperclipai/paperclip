import { describe, expect, it } from "vitest";
import { looksLikeDotenv, parseDotenv } from "./parse-dotenv";

describe("parseDotenv", () => {
  it("parses simple KEY=VALUE lines in order", () => {
    expect(parseDotenv("FOO=bar\nBAZ=qux")).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const text = "# a comment\n\nFOO=bar\n   \n# another\nBAZ=qux\n";
    expect(parseDotenv(text)).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("tolerates a leading `export`", () => {
    expect(parseDotenv("export TOKEN=abc123")).toEqual([{ key: "TOKEN", value: "abc123" }]);
  });

  it("strips a single layer of matching quotes", () => {
    expect(parseDotenv('A="hello world"\nB=\'single\'')).toEqual([
      { key: "A", value: "hello world" },
      { key: "B", value: "single" },
    ]);
  });

  it("keeps `=` characters inside the value", () => {
    expect(parseDotenv("DB_URL=postgres://u:p@host/db?x=1")).toEqual([
      { key: "DB_URL", value: "postgres://u:p@host/db?x=1" },
    ]);
  });

  it("strips trailing inline comments on unquoted values", () => {
    expect(parseDotenv("FOO=bar # trailing")).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("skips lines with invalid keys", () => {
    expect(parseDotenv("1BAD=x\n-also-bad=y\nGOOD=z")).toEqual([{ key: "GOOD", value: "z" }]);
  });

  it("returns an empty array for text with no assignments", () => {
    expect(parseDotenv("just some prose\nwith no equals")).toEqual([]);
  });

  it("allows empty values", () => {
    expect(parseDotenv("EMPTY=")).toEqual([{ key: "EMPTY", value: "" }]);
  });
});

describe("looksLikeDotenv", () => {
  it("is true for a single KEY=VALUE", () => {
    expect(looksLikeDotenv("FOO=bar")).toBe(true);
  });

  it("is false for a bare token with no equals", () => {
    expect(looksLikeDotenv("ghp_1234567890abcdef")).toBe(false);
  });

  it("is false for prose that happens to contain an equals but no valid key", () => {
    expect(looksLikeDotenv("1 = 1")).toBe(false);
  });
});
