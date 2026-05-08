import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertStaticUiDist, resolveStaticUiDist } from "../app.js";

// Helpers

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-test-"));
}

function withIndexHtml(dir: string): string {
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = makeTmpDir();
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// resolveStaticUiDist

describe("resolveStaticUiDist", () => {
  it("returns undefined when no candidate contains index.html", () => {
    const empty = tmpDir();
    expect(resolveStaticUiDist([empty, "/does/not/exist"])).toBeUndefined();
  });

  it("returns the first candidate that contains index.html", () => {
    const first = withIndexHtml(tmpDir());
    const second = withIndexHtml(tmpDir());
    expect(resolveStaticUiDist([first, second])).toBe(first);
  });

  it("skips candidates missing index.html and returns the next match", () => {
    const empty = tmpDir();
    const withHtml = withIndexHtml(tmpDir());
    expect(resolveStaticUiDist([empty, withHtml])).toBe(withHtml);
  });

  it("returns undefined for an empty candidates list", () => {
    expect(resolveStaticUiDist([])).toBeUndefined();
  });
});

// assertStaticUiDist — regression for BRA-513
// Verifies that the server refuses to start in dev when ui/dist is missing,
// instead of silently falling back to API-only mode.

describe("assertStaticUiDist", () => {
  it("returns the dist path when index.html is present", () => {
    const dist = withIndexHtml(tmpDir());
    expect(assertStaticUiDist([dist], "development")).toBe(dist);
    expect(assertStaticUiDist([dist], "production")).toBe(dist);
  });

  it("throws in development when no candidate has index.html", () => {
    const empty = tmpDir();
    expect(() => assertStaticUiDist([empty], "development")).toThrow(
      /UI dist not found|pnpm --filter @paperclipai\/ui build/,
    );
  });

  it("includes the searched paths in the dev error message", () => {
    const empty = tmpDir();
    expect(() => assertStaticUiDist([empty], "development")).toThrow(empty);
  });

  it("returns undefined in production when no candidate has index.html", () => {
    const empty = tmpDir();
    expect(assertStaticUiDist([empty], "production")).toBeUndefined();
  });

  it("returns undefined for an unrecognised nodeEnv value", () => {
    const empty = tmpDir();
    expect(assertStaticUiDist([empty], "staging")).toBeUndefined();
  });
});
