import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) collectTestFiles(absolute, found);
    else if (stats.isFile() && absolute.endsWith(".test.ts")) found.push(absolute);
  }
  return found;
}

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

const CONCURRENT_CALL = /Promise\.(?:all|allSettled|race)\s*\(\s*\[/g;

export function findConcurrentImportActual(source: string): number[] {
  const lines: number[] = [];
  CONCURRENT_CALL.lastIndex = 0;
  let match = CONCURRENT_CALL.exec(source);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = findClosingBracket(source, open);
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    const importActualCount = body.split("vi.importActual").length - 1;
    if (importActualCount >= 2) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
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
