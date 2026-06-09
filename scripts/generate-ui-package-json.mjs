#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const uiDir = join(repoRoot, "ui");
const packageJsonPath = join(uiDir, "package.json");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const publishPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  license: packageJson.license,
  homepage: packageJson.homepage,
  bugs: packageJson.bugs,
  repository: packageJson.repository,
  type: packageJson.type,
  files: ["dist"],
  publishConfig: {
    access: "public",
  },
};

writeFileSync(packageJsonPath, `${JSON.stringify(publishPackageJson, null, 2)}\n`);

console.log("  ✓ Generated publishable UI package.json");
