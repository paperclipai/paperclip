#!/usr/bin/env node
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const packageJsonPath = join(packageDir, "package.json");
const devPackageJsonPath = join(packageDir, "package.dev.json");

if (existsSync(devPackageJsonPath)) {
  rmSync(packageJsonPath, { force: true });
  renameSync(devPackageJsonPath, packageJsonPath);
}
