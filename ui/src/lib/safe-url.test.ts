// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { openSafeUrl, safeExternalHttpUrl, safeNavigableUrl } from "./safe-url";

const hostileInputs: ReadonlyArray<readonly [string, unknown]> = [
  ["javascript scheme", "javascript:alert(1)"],
  ["javascript scheme with an issue path", "javascript:alert(1)//issues/PAP-1"],
  ["mixed-case javascript scheme", "JaVaScRiPt:alert(1)"],
  ["javascript scheme after leading whitespace", "  javascript:alert(1)"],
  ["javascript scheme after a control character", "\u0001javascript:alert(1)"],
  ["javascript scheme split by a tab", "java\tscript:alert(1)"],
  ["javascript scheme split by a newline", "java\nscript:alert(1)"],
  ["vbscript scheme", "vbscript:msgbox(1)"],
  ["html data URL", "data:text/html,<script>alert(1)</script>"],
  ["base64 data URL", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
  ["svg data URL", "data:image/svg+xml,<svg onload=alert(1)>"],
  ["file URL", "file:///etc/passwd"],
  ["blob URL", "blob:https://paperclip.ing/1234"],
  ["filesystem URL", "filesystem:https://paperclip.ing/temporary/x"],
  ["about URL", "about:blank"],
  ["custom app scheme", "paperclip-desktop://open"],
  ["mention scheme", "agent://agent-1"],
  ["empty string", ""],
  ["whitespace only", "   "],
  ["null", null],
  ["undefined", undefined],
  ["number", 42],
  ["object", { href: "https://example.com" }],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeNavigableUrl", () => {
  it.each(hostileInputs)("rejects %s", (_label, input) => {
    expect(safeNavigableUrl(input)).toBeNull();
  });

  it.each([
    ["https URL", "https://example.com/a?b=c#d", "https://example.com/a?b=c#d"],
    ["http URL", "http://localhost:3100/issues/PAP-1", "http://localhost:3100/issues/PAP-1"],
    ["uppercase https scheme", "HTTPS://example.com/", "HTTPS://example.com/"],
    ["app-relative path", "/PAP/issues/PAP-1", "/PAP/issues/PAP-1"],
    ["fragment", "#comment-1", "#comment-1"],
    ["query", "?tab=files", "?tab=files"],
    ["path with surrounding whitespace", "  /issues/PAP-1  ", "/issues/PAP-1"],
  ])("keeps %s", (_label, input, expected) => {
    expect(safeNavigableUrl(input)).toBe(expected);
  });
});

describe("safeExternalHttpUrl", () => {
  it.each(hostileInputs)("rejects %s", (_label, input) => {
    expect(safeExternalHttpUrl(input)).toBeNull();
  });

  it("rejects relative paths", () => {
    expect(safeExternalHttpUrl("/issues/PAP-1")).toBeNull();
    expect(safeExternalHttpUrl("#comment-1")).toBeNull();
  });

  it("keeps absolute http and https URLs", () => {
    expect(safeExternalHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeExternalHttpUrl("http://example.com/x")).toBe("http://example.com/x");
  });
});

describe("openSafeUrl", () => {
  it.each(hostileInputs)("does not open %s", (_label, input) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openSafeUrl(input)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens http and same-origin URLs in a new context without an opener or referrer", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openSafeUrl("https://example.com/image.png")).toBe(true);
    expect(openSafeUrl("/api/attachments/1/content")).toBe(true);
    expect(open.mock.calls).toEqual([
      ["https://example.com/image.png", "_blank", "noopener,noreferrer"],
      ["/api/attachments/1/content", "_blank", "noopener,noreferrer"],
    ]);
  });
});
