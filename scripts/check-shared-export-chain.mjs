#!/usr/bin/env node
/**
 * check-shared-export-chain.mjs
 *
 * Asserts that every runtime value symbol imported by @paperclipai/server from
 * @paperclipai/shared is actually exported by the built dist.
 *
 * Scans ALL TypeScript source files under server/src/ (excluding test files)
 * so no import can slip through the guard regardless of which file it's in.
 *
 * Run as part of CI after `pnpm build` to catch export chain gaps
 * before they cause runtime startup crashes.
 *
 * Usage: node scripts/check-shared-export-chain.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// --- 1. Collect all server TypeScript source files (exclude tests and dist) ---

function collectTsFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      collectTsFiles(full, files);
    } else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
      files.push(full);
    }
  }
  return files;
}

const serverSrcDir = resolve(repoRoot, "server/src");
const serverFiles = collectTsFiles(serverSrcDir);

if (serverFiles.length === 0) {
  console.error("check-shared-export-chain: no TypeScript files found under server/src/ — check script logic");
  process.exit(1);
}

// --- 2. Extract all @paperclipai/shared import blocks from a source string ---
//
// Strategy: use a line-by-line state machine. An import block starts when we
// see "import" followed by "{" and ends when we see a line containing
// `from "<package>"`. We only keep blocks whose closing line contains
// `from "@paperclipai/shared"`.

function extractSharedImportBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let collecting = false;
  let accum = [];

  for (const line of lines) {
    if (!collecting) {
      // Look for the start of an import statement with a named-import brace
      if (/^\s*import\s+(type\s+)?\{/.test(line)) {
        collecting = true;
        accum = [line];
        // Also handle single-line case: import { X } from "pkg"
        const fromMatch = line.match(/\bfrom\s+["']([^"']+)["']/);
        if (fromMatch) {
          if (fromMatch[1] === "@paperclipai/shared") {
            blocks.push(accum.join("\n"));
          }
          collecting = false;
          accum = [];
        }
      }
    } else {
      accum.push(line);
      const fromMatch = line.match(/\bfrom\s+["']([^"']+)["']/);
      if (fromMatch) {
        if (fromMatch[1] === "@paperclipai/shared") {
          blocks.push(accum.join("\n"));
        }
        // Either way, the import block is closed
        collecting = false;
        accum = [];
      }
    }
  }

  return blocks;
}

function isTypeOnlyImportBlock(block) {
  return /^\s*import\s+type\s*\{/.test(block);
}

// --- 3. Parse all named imports from @paperclipai/shared across all server files ---

const symbolsFromShared = new Set();
const symbolSources = new Map(); // symbol → first file it was seen in (for diagnostics)

for (const filePath of serverFiles) {
  const source = readFileSync(filePath, "utf8");
  const blocks = extractSharedImportBlocks(source);

  for (const block of blocks) {
    if (isTypeOnlyImportBlock(block)) continue;
    const match = block.match(/\{([^}]+)\}/s);
    if (!match) continue;
    for (const rawName of match[1].split(",")) {
      const trimmed = rawName.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      if (/^type\s+/.test(trimmed)) continue;
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (name && !symbolsFromShared.has(name)) {
        symbolsFromShared.add(name);
        symbolSources.set(name, filePath.replace(repoRoot + "/", ""));
      }
    }
  }
}

if (symbolsFromShared.size === 0) {
  console.error("check-shared-export-chain: no imports from @paperclipai/shared found in server/src — check script logic");
  process.exit(1);
}

// --- 4. Load the actual dist exports ---

const sharedDistPath = resolve(repoRoot, "packages/shared/dist/index.js");
let sharedExports;
try {
  const require = createRequire(import.meta.url);
  sharedExports = require(sharedDistPath);
} catch (err) {
  console.error(`check-shared-export-chain: failed to load shared dist at ${sharedDistPath}:`);
  console.error(err.message);
  process.exit(1);
}

const exportedKeys = new Set(Object.keys(sharedExports));

// --- 5. Report missing symbols ---

const missing = [];
for (const sym of symbolsFromShared) {
  if (!exportedKeys.has(sym)) {
    missing.push({ sym, file: symbolSources.get(sym) });
  }
}

if (missing.length > 0) {
  console.error(`check-shared-export-chain: FAIL — ${missing.length} symbol(s) imported by @paperclipai/server are missing from @paperclipai/shared dist:`);
  for (const { sym, file } of missing) {
    console.error(`  - ${sym}  (first seen in ${file})`);
  }
  console.error("\nFix: add the missing exports to packages/shared/src/index.ts (and ensure they exist in the source files), then rebuild with `pnpm --filter @paperclipai/shared build`.");
  process.exit(1);
}

console.log(`check-shared-export-chain: OK — all ${symbolsFromShared.size} symbols from @paperclipai/shared (across ${serverFiles.length} server source files) are present in the dist`);
