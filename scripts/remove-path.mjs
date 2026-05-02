#!/usr/bin/env node
import { rm } from "node:fs/promises";

const target = process.argv[2];

if (!target) {
  console.error("Usage: node scripts/remove-path.mjs <path>");
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
