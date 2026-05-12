import { describe, expect, it } from "vitest";
import { sanitizeCustomFieldUrl } from "./custom-field-url";

describe("sanitizeCustomFieldUrl", () => {
  it("returns null for empty string", () => {
    expect(sanitizeCustomFieldUrl("")).toBeNull();
  });

  it("returns null for plain text (no scheme)", () => {
    expect(sanitizeCustomFieldUrl("not a url")).toBeNull();
  });

  it("returns null for javascript: URL (XSS attack vector)", () => {
    expect(sanitizeCustomFieldUrl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for javascript: URL with obfuscated casing", () => {
    expect(sanitizeCustomFieldUrl("JaVaScRiPt:alert(1)")).toBeNull();
  });

  it("returns null for data: URL", () => {
    expect(sanitizeCustomFieldUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("returns null for vbscript: URL", () => {
    expect(sanitizeCustomFieldUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("returns normalized href for valid https URL", () => {
    const result = sanitizeCustomFieldUrl("https://example.com/path?q=1");
    expect(result).toBe("https://example.com/path?q=1");
  });

  it("returns normalized href for valid http URL", () => {
    const result = sanitizeCustomFieldUrl("http://example.com");
    expect(result).toBe("http://example.com/");
  });

  it("handles https URL with fragment", () => {
    const result = sanitizeCustomFieldUrl("https://example.com/docs#section");
    expect(result).toBe("https://example.com/docs#section");
  });

  it("returns null for file: URL", () => {
    expect(sanitizeCustomFieldUrl("file:///etc/passwd")).toBeNull();
  });

  it("returns null for ftp: URL", () => {
    expect(sanitizeCustomFieldUrl("ftp://files.example.com")).toBeNull();
  });

  it("handles URL with HTML-special characters in path (not XSS)", () => {
    const result = sanitizeCustomFieldUrl("https://example.com/search?q=<foo>");
    // URL constructor encodes < and > so the resulting href is safe
    expect(result).not.toBeNull();
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });
});
