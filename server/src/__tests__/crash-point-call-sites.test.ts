import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRASH_POINTS } from "@paperclipai/shared/crash-points";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const SOURCE_ROOTS = ["server/src", "packages/paperclip-runner/src"];
const CALL = /\bcrashPoint\(\s*"([^"]+)"\s*\)/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function callSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(path.join(repositoryRoot, root))) {
      for (const match of readFileSync(file, "utf8").matchAll(CALL)) {
        const list = sites.get(match[1]!) ?? [];
        list.push(path.relative(repositoryRoot, file));
        sites.set(match[1]!, list);
      }
    }
  }
  return sites;
}

describe("crash-point call sites", () => {
  const sites = callSites();

  it("instruments every registered crash point", () => {
    const missing = Object.keys(CRASH_POINTS).filter(name => !sites.has(name));
    expect(missing).toEqual([]);
  });

  it("calls only registered crash points", () => {
    const unknown = [...sites.keys()].filter(name => !(name in CRASH_POINTS));
    expect(unknown).toEqual([]);
  });

  it("names only ownable kinds of the Phase 1 registry", () => {
    const known = new Set(OWNABLE_KINDS.map(kind => kind.id));
    const unknown = Object.entries(CRASH_POINTS).flatMap(([name, definition]) =>
      definition.kinds.filter(kind => !known.has(kind)).map(kind => `${name}: ${kind}`));
    expect(unknown).toEqual([]);
  });
});
