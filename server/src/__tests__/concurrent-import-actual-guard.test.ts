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

// Whitespace-tolerant on purpose. `Promise.all( [` and an array argument on the
// next line are the same hazard, and the multiline form is common in this repo,
// so an exact `Promise.all([` needle would wave most of them through.
// `allSettled` and `race` resolve their arguments concurrently too.
const CONCURRENT_CALL = /Promise\.(?:all|allSettled|race)\s*\(\s*\[/g;

export function findConcurrentImportActual(source: string): number[] {
  const lines: number[] = [];
  CONCURRENT_CALL.lastIndex = 0;
  let match = CONCURRENT_CALL.exec(source);
  while (match !== null) {
    // The regex ends at the `[`, so its last character is the opening bracket.
    const open = match.index + match[0].length - 1;
    const close = findClosingBracket(source, open);
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    const importActualCount = body.split("vi.importActual").length - 1;
    if (importActualCount >= 2) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
    // Resume past the closing bracket so nested calls are not double-counted.
    CONCURRENT_CALL.lastIndex = close;
    match = CONCURRENT_CALL.exec(source);
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

  // The detector is what makes the scan above meaningful, so its blind spots are
  // worth asserting directly. Each of these is a formatting variant that an
  // exact `Promise.all([` match would silently pass.
  it.each([
    ["tight", 'Promise.all([vi.importActual("a"), vi.importActual("b")]);'],
    ["space before bracket", 'Promise.all( [vi.importActual("a"), vi.importActual("b")]);'],
    ["array on the next line", 'Promise.all(\n  [vi.importActual("a"), vi.importActual("b")],\n);'],
    ["allSettled", 'Promise.allSettled([vi.importActual("a"), vi.importActual("b")]);'],
    ["race", 'Promise.race([vi.importActual("a"), vi.importActual("b")]);'],
  ])("flags concurrent vi.importActual() written as %s", (_label, source) => {
    expect(findConcurrentImportActual(source)).toHaveLength(1);
  });

  it.each([
    ["a single vi.importActual", 'Promise.all([vi.importActual("a"), other()]);'],
    ["no vi.importActual at all", "Promise.all([fetchOne(), fetchTwo()]);"],
  ])("does not flag %s", (_label, source) => {
    expect(findConcurrentImportActual(source)).toEqual([]);
  });
});
