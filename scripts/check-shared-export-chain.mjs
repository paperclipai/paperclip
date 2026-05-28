#!/usr/bin/env node
/**
 * check-shared-export-chain.mjs
 *
 * Asserts that every symbol imported by @paperclipai/server from
 * @paperclipai/shared is actually exported by the built dist.
 *
 * Run as part of CI after `pnpm build` to catch export chain gaps
 * before they cause runtime startup crashes.
 *
 * Usage: node scripts/check-shared-export-chain.mjs
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// --- 1. Parse all named imports from @paperclipai/shared in the server source ---

const serverRoutesPath = resolve(repoRoot, "server/src/routes/issues.ts");
const serverSource = readFileSync(serverRoutesPath, "utf8");

// Collect all import blocks from @paperclipai/shared (may span multiple lines)
const importBlocks = [];
let inSharedImport = false;
let currentBlock = "";

for (const line of serverSource.split("\n")) {
  if (!inSharedImport && line.includes("from") && line.includes(`"@paperclipai/shared"`)) {
    // Single-line import
    importBlocks.push(line);
  } else if (!inSharedImport && line.trim().startsWith("import") && line.includes("{")) {
    // Potential multi-line import block start
    currentBlock = line;
    inSharedImport = true;
  }

  if (inSharedImport) {
    if (line !== currentBlock) currentBlock += "\n" + line;
    if (line.includes(`"@paperclipai/shared"`)) {
      importBlocks.push(currentBlock);
      inSharedImport = false;
      currentBlock = "";
    }
    if (
      line.includes(`"@paperclipai/`) &&
      !line.includes(`"@paperclipai/shared"`) &&
      line.includes("from")
    ) {
      // Different import — reset
      inSharedImport = false;
      currentBlock = "";
    }
  }
}

// Check if the entire import block is `import type { ... }`
function isTypeOnlyImportBlock(block) {
  return /^\s*import\s+type\s*\{/.test(block);
}

// Extract runtime value symbol names (skip `type X` and `import type` blocks)
const symbolsFromShared = new Set();
for (const block of importBlocks) {
  if (!block.includes(`"@paperclipai/shared"`)) continue;
  if (isTypeOnlyImportBlock(block)) continue; // entire import is type-only
  // Extract names between { }
  const match = block.match(/\{([^}]+)\}/s);
  if (!match) continue;
  for (const rawName of match[1].split(",")) {
    const trimmed = rawName.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    // Skip per-symbol `type X` annotations
    if (/^type\s+/.test(trimmed)) continue;
    // Handle `X as Y` — we want the original export name X
    const name = trimmed.split(/\s+as\s+/)[0].trim();
    if (name) {
      symbolsFromShared.add(name);
    }
  }
}

if (symbolsFromShared.size === 0) {
  console.error("check-shared-export-chain: no imports from @paperclipai/shared found in server routes — check script logic");
  process.exit(1);
}

// --- 2. Load the actual dist exports ---

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

// --- 3. Report missing symbols ---

const missing = [];
for (const sym of symbolsFromShared) {
  if (!exportedKeys.has(sym)) {
    missing.push(sym);
  }
}

if (missing.length > 0) {
  console.error("check-shared-export-chain: FAIL — the following symbols are imported by @paperclipai/server but missing from @paperclipai/shared dist:");
  for (const sym of missing) {
    console.error(`  - ${sym}`);
  }
  console.error("\nFix: add the missing exports to packages/shared/src/index.ts (and ensure they exist in the source files), then rebuild with `pnpm --filter @paperclipai/shared build`.");
  process.exit(1);
}

console.log(`check-shared-export-chain: OK — all ${symbolsFromShared.size} symbols from @paperclipai/shared are present in the dist`);
