import { describe, expect, it } from "vitest";
import { isLocalFileHref, normalizeLocalPath } from "./local-document";

describe("isLocalFileHref", () => {
  it.each([
    ["/Users/foo/x.md", true],
    ["/Volumes/Disk/x.md", true],
    ["~/x.md", true],
    ["file:///Users/foo/x.md", true],
    ["file:///C:/foo/x.md", true],
    ["C:\\Users\\Foo\\x.md", true],
    ["C:/Users/Foo/x.md", true],
    ["D:\\foo.md", true],
    ["\\\\server\\share\\x.md", true],
  ])("recognizes %s as local", (href, expected) => {
    expect(isLocalFileHref(href)).toBe(expected);
  });

  it.each([
    ["http://example.com/x.md", false],
    ["https://example.com/x.md", false],
    ["mailto:foo@bar.com", false],
    ["pcfile://abc", false],
    ["/issues/PCL-123", false],
    ["./relative.md", false],
    ["../up.md", false],
    ["", false],
  ])("does NOT recognize %s as local", (href, expected) => {
    expect(isLocalFileHref(href)).toBe(expected);
  });
});

describe("normalizeLocalPath", () => {
  it("strips file:/// prefix for POSIX paths", () => {
    expect(normalizeLocalPath("file:///Users/foo/x.md")).toBe("/Users/foo/x.md");
  });

  it("strips file:/// prefix and leading / for Windows paths", () => {
    expect(normalizeLocalPath("file:///C:/foo/x.md")).toBe("C:/foo/x.md");
  });

  it("decodes URL-encoded chars", () => {
    expect(normalizeLocalPath("/Users/foo%20bar/x.md")).toBe("/Users/foo bar/x.md");
    expect(normalizeLocalPath("file:///Users/foo%20bar/x.md")).toBe("/Users/foo bar/x.md");
  });

  it("leaves tilde paths unchanged (server expands)", () => {
    expect(normalizeLocalPath("~/x.md")).toBe("~/x.md");
  });

  it("leaves backslash paths unchanged", () => {
    expect(normalizeLocalPath("C:\\foo\\x.md")).toBe("C:\\foo\\x.md");
  });

  it("gracefully passes through invalid URL-encoded sequences", () => {
    expect(normalizeLocalPath("/Users/foo%ZZ.md")).toBe("/Users/foo%ZZ.md");
  });
});
