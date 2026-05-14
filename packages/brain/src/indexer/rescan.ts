import { readdir } from "node:fs/promises";
import path from "node:path";
import type { BrainDbHandle } from "../db/client.js";
import type { Embedder } from "./embedder.js";
import { indexFile, type IndexResult } from "./watcher.js";

const SKIP_DIRS = new Set([".obsidian", ".trash", "node_modules", ".git"]);

async function walkDir(root: string, base = root): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkDir(full, base)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export interface RescanCounters {
  indexed: number;
  skipped: number;
  unchanged: number;
  empty: number;
  errors: number;
  total: number;
}

export async function fullRescan(
  handle: BrainDbHandle,
  embed: Embedder,
  vaultRoot: string,
  onProgress?: (counters: RescanCounters, lastPath: string) => void,
): Promise<RescanCounters> {
  const counters: RescanCounters = {
    indexed: 0,
    skipped: 0,
    unchanged: 0,
    empty: 0,
    errors: 0,
    total: 0,
  };
  const files = await walkDir(vaultRoot);
  counters.total = files.length;
  for (const f of files) {
    try {
      const result: IndexResult = await indexFile(handle, embed, vaultRoot, f);
      counters[result]++;
    } catch (e) {
      counters.errors++;
      console.error(`[rescan] failed: ${f}:`, e instanceof Error ? e.message : String(e));
    }
    if (onProgress) onProgress(counters, f);
  }
  return counters;
}
