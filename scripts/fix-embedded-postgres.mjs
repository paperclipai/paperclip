#!/usr/bin/env node
/**
 * Fix script for Paperclip embedded-postgres platform dependency issues
 * Run this after `pnpm install` if you get ERR_MODULE_NOT_FOUND for @embedded-postgres packages
 *
 * Usage:
 *   node scripts/fix-embedded-postgres.mjs
 *   or
 *   pnpm fix:postgres
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PLATFORM = process.platform;
const ARCH = process.arch;

const PLATFORM_MAP = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "win32-x64": "@embedded-postgres/win32-x64",
};

const platformKey = `${PLATFORM}-${ARCH}`;
const pkgName = PLATFORM_MAP[platformKey];

if (!pkgName) {
  console.error(`[paperclip-fix] Unsupported platform: ${platformKey}`);
  console.error(`[paperclip-fix] Supported platforms: ${Object.keys(PLATFORM_MAP).join(", ")}`);
  process.exit(1);
}

console.log(`[paperclip-fix] Platform detected: ${platformKey}`);
console.log(`[paperclip-fix] Platform package: ${pkgName}`);

// Read embedded-postgres version from packages/db/package.json
const dbPackageJsonPath = path.resolve(__dirname, "../packages/db/package.json");
let embeddedPgVersion;

try {
  const dbPackageJson = JSON.parse(readFileSync(dbPackageJsonPath, "utf-8"));
  const depVersion = dbPackageJson.dependencies?.["embedded-postgres"];
  if (depVersion) {
    // Extract version number from ^version or ~version
    const match = depVersion.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    embeddedPgVersion = match ? match[1] : depVersion;
  }
} catch (err) {
  console.error(`[paperclip-fix] ERROR: Could not read packages/db/package.json: ${err.message}`);
  process.exit(1);
}

if (!embeddedPgVersion) {
  console.error("[paperclip-fix] ERROR: Could not determine embedded-postgres version");
  process.exit(1);
}

console.log(`[paperclip-fix] embedded-postgres version: ${embeddedPgVersion}`);

// Check if already installed
try {
  require(pkgName);
  console.log(`[paperclip-fix] ✓ Platform package ${pkgName} is already installed`);
  console.log("[paperclip-fix] No action needed. You can run: pnpm dev");
  process.exit(0);
} catch {
  console.log("[paperclip-fix] Platform package not found, attempting to install...");
}

// Try to install the exact version
function checkVersionExists(pkg, version) {
  try {
    execSync(`pnpm view "${pkg}@${version}" version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getLatestVersion(pkg) {
  try {
    const output = execSync(`pnpm view "${pkg}" version`, { encoding: "utf-8", stdio: "pipe" });
    return output.trim();
  } catch {
    return null;
  }
}

let versionToInstall = embeddedPgVersion;

if (!checkVersionExists(pkgName, embeddedPgVersion)) {
  console.log(`[paperclip-fix] Exact version ${embeddedPgVersion} not found, finding latest compatible version...`);
  const latestVersion = getLatestVersion(pkgName);

  if (!latestVersion) {
    console.error(`[paperclip-fix] ERROR: Could not find any version of ${pkgName}`);
    console.error("[paperclip-fix] Please check your internet connection or npm registry access");
    process.exit(1);
  }

  versionToInstall = latestVersion;
  console.log(`[paperclip-fix] Will install latest available: ${pkgName}@${versionToInstall}`);
} else {
  console.log(`[paperclip-fix] Installing ${pkgName}@${versionToInstall}...`);
}

// Install the package
try {
  execSync(`pnpm add -D "${pkgName}@${versionToInstall}" --filter @paperclipai/db`, {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  });
} catch (err) {
  console.error(`[paperclip-fix] ERROR: Installation failed: ${err.message}`);
  process.exit(1);
}

// Verify installation
try {
  require(pkgName);
  console.log("[paperclip-fix] ✓ Success! Platform package installed.");
  console.log("[paperclip-fix] You can now run: pnpm dev");
} catch (err) {
  console.error(`[paperclip-fix] ERROR: Installation verification failed: ${err.message}`);
  process.exit(1);
}
