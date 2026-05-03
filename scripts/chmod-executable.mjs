#!/usr/bin/env node
import { chmod } from "node:fs/promises";

const target = process.argv[2];

if (!target) {
  console.error("Usage: node scripts/chmod-executable.mjs <path>");
  process.exit(1);
}

await chmod(target, 0o755);
