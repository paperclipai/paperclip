#!/usr/bin/env node
// rimraf.mjs — Cross-platform recursive delete. Replaces `rm -rf <path>...` in
// package scripts so build/pack lifecycle steps run on Windows without a shell.
//
// Usage: node scripts/rimraf.mjs <path> [<path> ...]
// Paths are resolved relative to process.cwd() (npm runs scripts from the
// package directory), matching the previous `rm -rf` behavior.

import { rmSync } from "node:fs";
import path from "node:path";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("rimraf.mjs: expected at least one path argument");
  process.exit(1);
}

for (const target of targets) {
  rmSync(path.resolve(process.cwd(), target), { recursive: true, force: true });
}
