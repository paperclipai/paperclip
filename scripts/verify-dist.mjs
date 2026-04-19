#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const requiredArtifacts = [
  "packages/db/dist/index.js",
  "packages/db/dist/client.js",
  "packages/db/dist/migrations",
  "packages/shared/dist/index.js",
  "server/dist/index.js",
];

let missing = 0;

for (const artifact of requiredArtifacts) {
  const full = resolve(root, artifact);
  if (!existsSync(full)) {
    console.error(`MISSING: ${artifact}`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`\nverify-dist: ${missing} required artifact(s) missing. Build is incomplete.`);
  process.exit(1);
}

console.log(`verify-dist: all ${requiredArtifacts.length} required artifacts present.`);
