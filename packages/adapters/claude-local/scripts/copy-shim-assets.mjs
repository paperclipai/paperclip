#!/usr/bin/env node
// Copy leak-check shim runtime assets from src/ to dist/ as a post-tsc step.
// tsc only emits .ts → .js; the shim's standalone .mjs files (spawned as a
// subprocess by the host) must be alongside the compiled host.js.

import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __thisDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__thisDir, "..");
const sourceDir = path.resolve(packageRoot, "src/server/leak-check");
const targetDir = path.resolve(packageRoot, "dist/server/leak-check");

const ASSETS = ["parse.mjs", "shim-entry.mjs", "parse.d.mts"];

await mkdir(targetDir, { recursive: true });
for (const asset of ASSETS) {
  await copyFile(path.join(sourceDir, asset), path.join(targetDir, asset));
}
console.log(`copied ${ASSETS.length} shim assets to ${targetDir}`);
