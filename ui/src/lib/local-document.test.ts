import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLocalFileHref,
  normalizeLocalPath,
  documentOpenerHealth,
  openDocument,
  revealDocument,
  DOCUMENT_OPENER_BASE_URL,
} from "./local-document";

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

describe("fetch helpers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("openDocument POSTs to /open with normalized path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await openDocument("file:///Users/foo/x.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `${DOCUMENT_OPENER_BASE_URL}/open`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/Users/foo/x.md" }),
      }),
    );
  });

  it("revealDocument POSTs to /reveal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await revealDocument("/Users/foo/x.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `${DOCUMENT_OPENER_BASE_URL}/reveal`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/Users/foo/x.md" }),
      }),
    );
  });

  it("openDocument throws on non-2xx with parsed error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "path outside allowed roots" }), { status: 403 }),
    );
    await expect(openDocument("/etc/hosts")).rejects.toThrow(/path outside allowed roots/);
  });

  it("openDocument throws on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(openDocument("/Users/foo/x.md")).rejects.toThrow();
  });

  it("documentOpenerHealth returns 'ready' on 200", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await documentOpenerHealth();
    expect(result).toBe("ready");
  });

  it("documentOpenerHealth returns 'unavailable' on 503", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const result = await documentOpenerHealth();
    expect(result).toBe("unavailable");
  });

  it("documentOpenerHealth returns 'unavailable' on network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await documentOpenerHealth();
    expect(result).toBe("unavailable");
  });
});
