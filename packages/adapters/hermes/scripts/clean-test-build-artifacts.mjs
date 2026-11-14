#!/usr/bin/env node
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");

function removeTestArtifacts(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      removeTestArtifacts(path);
    } else if (/\.(?:test|spec)\./.test(entry.name)) {
      rmSync(path);
    }
  }
}

removeTestArtifacts(distDir);
