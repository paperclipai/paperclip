#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.VERCEL !== "1") {
  console.log("Skipping workspace export patch (VERCEL is not set).");
  process.exit(0);
}

function collectPackageJsonPaths(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = path.join(dir, entry.name, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      results.push(packageJsonPath);
    }
  }
  return results;
}

const packageJsonPaths = [
  ...collectPackageJsonPaths(path.join(rootDir, "packages")),
  ...collectPackageJsonPaths(path.join(rootDir, "packages", "adapters")),
];

let patched = 0;
for (const packageJsonPath of packageJsonPaths) {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);
  const publishExports = pkg.publishConfig?.exports;
  if (!publishExports) continue;
  if (JSON.stringify(pkg.exports) === JSON.stringify(publishExports)) continue;

  pkg.exports = publishExports;
  if (pkg.publishConfig?.main) {
    pkg.main = pkg.publishConfig.main;
  }
  if (pkg.publishConfig?.types) {
    pkg.types = pkg.publishConfig.types;
  }
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  patched += 1;
  console.log(`Patched workspace exports for ${path.relative(rootDir, packageJsonPath)}`);
}

console.log(`Patched ${patched} workspace package.json file(s) for Vercel runtime.`);
