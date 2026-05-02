#!/usr/bin/env node
import { cp, rm } from "node:fs/promises";

const args = process.argv.slice(2);
const cleanDest = args[0] === "--clean-dest";
const [source, destination] = cleanDest ? args.slice(1) : args;

if (!source || !destination) {
  console.error("Usage: node scripts/copy-path.mjs [--clean-dest] <source> <destination>");
  process.exit(1);
}

if (cleanDest) {
  await rm(destination, { recursive: true, force: true });
}

await cp(source, destination, {
  force: true,
  recursive: true,
});
