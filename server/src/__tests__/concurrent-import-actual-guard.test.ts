import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest resolves factory (`manual`) mocks through a single shared field,
// `mockContext.callstack`, and `vi.importActual()` reads that same field. The
// Vitest source says so directly:
//
//   // this will not work if user does Promise.all(import(), import())
//
// When two `vi.importActual()` module graphs resolve at the same time, their
// pushes and their `finally` resets interleave. The
// `!callstack.includes(mockId)` guard can then evaluate against the other
// graph's callstack, the factory mock is skipped, and the real module loads
// instead. The result is a partially mocked module graph that fails rarely and
// reports an unrelated error, so it is expensive to diagnose every time it
// reappears.
//
// Await `vi.importActual()` calls one at a time instead. This test keeps the
// pattern from coming back.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "ui-dist",
]);

function collectTestFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(dir, entry);
    // lstat, not stat: the workspace uses symlinks, and following them can
    // revisit a tree or cycle forever.
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) collectTestFiles(absolute, found);
    else if (stats.isFile() && absolute.endsWith(".test.ts")) found.push(absolute);
  }
  return found;
}

/** Index of the `]` that closes the `[` at `open`. */
function findClosingBracket(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === "[") depth++;
    else if (character === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findConcurrentImportActual(source: string): number[] {
  const needle = "Promise.all([";
  const lines: number[] = [];
  let cursor = source.indexOf(needle);
  while (cursor !== -1) {
    const open = cursor + needle.length - 1;
    const close = findClosingBracket(source, open);
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    const importActualCount = body.split("vi.importActual").length - 1;
    if (importActualCount >= 2) {
      lines.push(source.slice(0, cursor).split("\n").length);
    }
    cursor = source.indexOf(needle, close);
  }
  return lines;
}

describe("vitest mock safety", () => {
  it("never resolves two vi.importActual() calls concurrently", () => {
    const selfPath = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    for (const file of collectTestFiles(repoRoot)) {
      // This file names the pattern it forbids, so it must not scan itself.
      if (file === selfPath) continue;
      const source = readFileSync(file, "utf8");
      for (const line of findConcurrentImportActual(source)) {
        offenders.push(`${path.relative(repoRoot, file)}:${line}`);
      }
    }

    expect(
      offenders,
      "Await these vi.importActual() calls one at a time. Concurrent resolution "
        + "can drop a factory mock and load the real module instead.",
    ).toEqual([]);
  });
});
