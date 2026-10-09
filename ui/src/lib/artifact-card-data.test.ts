import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactNumber,
  artifactPreviewUrl,
  artifactUrl,
  CSV_PREVIEW_MAX_BYTES,
  loadArtifactCsv,
  parseArtifactCsv,
} from "./artifact-card-data";

afterEach(() => vi.unstubAllGlobals());

describe("artifact metadata", () => {
  it("does not turn absent or invalid counts into zero", () => {
    for (const value of [undefined, null, "12", -1, Infinity, NaN])
      expect(artifactNumber({ additions: value }, "additions")).toBeNull();
    expect(artifactNumber({ additions: 0 }, "additions")).toBe(0);
  });
  it("loads optional thumbnails only through local authenticated attachment routes", () => {
    for (const value of [
      "https://example.com/tracker.png",
      "http://127.0.0.1/private",
      "//evil.test/track",
      "/api/companies",
      "/api/attachments/a/content?redirect=1",
    ])
      expect(artifactPreviewUrl(value)).toBe("");
    expect(artifactPreviewUrl("/api/attachments/file-1/content")).toBe(
      "/api/attachments/file-1/content",
    );
  });
  it("permits web and root-relative URLs only", () => {
    for (const url of [
      "javascript:alert(1)",
      "//evil.test",
      "/\\evil.test",
      "data:text/html,hello",
      "https:\n//evil.test",
    ])
      expect(artifactUrl(url)).toBe("");
    expect(artifactUrl("/api/attachments/a/content")).toBe(
      "/api/attachments/a/content",
    );
    expect(artifactUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });
});

describe("CSV artifact preview", () => {
  it("reads quoted commas, escaped quotes, embedded newlines, CRLF, BOM and empty cells", () => {
    expect(
      parseArtifactCsv(
        '\uFEFFName,Notes,Count\r\n"Smith, Jo","a ""quote""\nand line",0\r\nOther,,2\r\n',
      ),
    ).toEqual({
      columns: ["Name", "Notes", "Count"],
      rows: [
        ["Smith, Jo", 'a "quote"\nand line', "0"],
        ["Other", "", "2"],
      ],
      truncated: false,
    });
  });
  it("bounds rows, columns and bytes and rejects malformed quoting", () => {
    const preview = parseArtifactCsv(
      "Name\n" + Array.from({ length: 202 }, (_, i) => `${i}`).join("\n"),
    );
    expect(preview.rows).toHaveLength(200);
    expect(preview.truncated).toBe(true);
    expect(() => parseArtifactCsv(Array(51).fill("x").join(","))).toThrow(
      "too many columns",
    );
    expect(() =>
      parseArtifactCsv("x".repeat(CSV_PREVIEW_MAX_BYTES + 1)),
    ).toThrow("too large");
    expect(() => parseArtifactCsv('Name\n"unfinished')).toThrow(
      "could not be previewed",
    );
    expect(() => parseArtifactCsv('Name\n"closed"extra')).toThrow(
      "could not be previewed",
    );
    expect(parseArtifactCsv("")).toEqual({
      columns: [],
      rows: [],
      truncated: false,
    });
  });
  it("never fetches remote or arbitrary local URLs", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const path of [
      "https://example.com/data.csv",
      "/api/companies",
      "/api/attachments/a/content?redirect=yes",
    ])
      await expect(loadArtifactCsv(path)).rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses authenticated attachment content with no redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("A,B\n1,2"));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(
      (await loadArtifactCsv("/api/attachments/file-1/content", signal)).rows,
    ).toEqual([["1", "2"]]);
    expect(fetcher).toHaveBeenCalledWith("/api/attachments/file-1/content", {
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
  });
  it("stops oversized streamed files even when the server sends no content length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(CSV_PREVIEW_MAX_BYTES + 1));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(
      loadArtifactCsv("/api/attachments/file-1/content"),
    ).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
  });
});
