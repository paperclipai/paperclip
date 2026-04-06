import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIndexHtmlGetter } from "../app.ts";

function writeTempIndexHtml(dir: string, content: string): string {
  const p = path.join(dir, "index.html");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("createIndexHtmlGetter", () => {
  it("returns the contents of index.html on first call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-"));
    const p = writeTempIndexHtml(dir, "<html>v1</html>");
    const get = createIndexHtmlGetter(p);
    expect(get()).toContain("v1");
  });

  it("returns the cached value when mtime has not changed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-"));
    const p = writeTempIndexHtml(dir, "<html>v1</html>");

    // Pin mtime to a clean integer before priming the cache so that
    // utimesSync can restore it exactly (avoids sub-ms precision loss).
    const pinnedDate = new Date(1_000_000_000_000);
    fs.utimesSync(p, pinnedDate, pinnedDate);

    const get = createIndexHtmlGetter(p);
    const first = get();

    // Overwrite content but keep the same pinned mtime
    fs.writeFileSync(p, "<html>sneaky</html>", "utf-8");
    fs.utimesSync(p, pinnedDate, pinnedDate);

    expect(get()).toBe(first);
  });

  it("returns cached html when file is transiently absent after first read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-"));
    const p = writeTempIndexHtml(dir, "<html>v1</html>");
    const get = createIndexHtmlGetter(p);

    const first = get(); // prime cache

    // Simulate the file being removed mid-hotpatch
    fs.unlinkSync(p);

    expect(get()).toBe(first);
  });

  it("throws when file is absent on the very first read", () => {
    const p = path.join(os.tmpdir(), "paperclip-spa-nonexistent-index.html");
    const get = createIndexHtmlGetter(p);
    expect(() => get()).toThrow();
  });

  it("re-reads from disk when mtime advances", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-"));
    const p = writeTempIndexHtml(dir, "<html>v1</html>");
    const get = createIndexHtmlGetter(p);

    get(); // prime cache

    // Simulate a ui-dist refresh by writing new content with a future mtime
    const futureDate = new Date(Date.now() + 2000);
    fs.writeFileSync(p, "<html>v2</html>", "utf-8");
    fs.utimesSync(p, futureDate, futureDate);

    expect(get()).toContain("v2");
  });
});
