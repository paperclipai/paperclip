import { describe, expect, it } from "vitest";
import { isSafeReturnTo } from "./google-sso";

describe("isSafeReturnTo", () => {
  it("accepts a plain single-leading-slash relative path", () => {
    expect(isSafeReturnTo("/issues")).toBe("/issues");
  });

  it("accepts a path with query string and fragment", () => {
    expect(isSafeReturnTo("/companies/abc123?tab=issues")).toBe("/companies/abc123?tab=issues");
  });

  it("accepts a path with multiple segments", () => {
    expect(isSafeReturnTo("/a/b/c/d")).toBe("/a/b/c/d");
  });

  it("rejects protocol-relative URL (//)", () => {
    expect(isSafeReturnTo("//evil.com")).toBeNull();
  });

  it("rejects backslash-leading value", () => {
    expect(isSafeReturnTo("\\evil.com")).toBeNull();
  });

  it("rejects value containing a backslash", () => {
    expect(isSafeReturnTo("/a\\b")).toBeNull();
  });

  it("rejects colon-leading value (protocol-relative without //)", () => {
    expect(isSafeReturnTo("://evil.com")).toBeNull();
  });

  it("rejects javascript: scheme", () => {
    expect(isSafeReturnTo("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: scheme", () => {
    expect(isSafeReturnTo("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  it("rejects http absolute URL", () => {
    expect(isSafeReturnTo("http://evil.com")).toBeNull();
  });

  it("rejects https absolute URL", () => {
    expect(isSafeReturnTo("https://evil.com")).toBeNull();
  });

  it("rejects null", () => {
    expect(isSafeReturnTo(null)).toBeNull();
  });

  it("rejects undefined", () => {
    expect(isSafeReturnTo(undefined)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(isSafeReturnTo("")).toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(isSafeReturnTo("   ")).toBeNull();
  });

  it("rejects value that does not start with /", () => {
    expect(isSafeReturnTo("issues")).toBeNull();
  });

  it("accepts root path /", () => {
    expect(isSafeReturnTo("/")).toBe("/");
  });
});
