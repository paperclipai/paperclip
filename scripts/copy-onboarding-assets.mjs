#!/usr/bin/env node
// copy-onboarding-assets.mjs — Copy server/src/onboarding-assets into the build
// output (dist/onboarding-assets). Replaces the POSIX `mkdir -p && cp -R` used by
// the @paperclipai/server build script so it runs on Windows without a shell.
//
// Invoked from the server package directory (npm sets cwd to the package root),
// so paths resolve relative to process.cwd().

import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const srcDir = path.join(process.cwd(), "src", "onboarding-assets");
const destDir = path.join(process.cwd(), "dist", "onboarding-assets");

if (!existsSync(srcDir)) {
  console.error(`Error: onboarding assets source missing at ${srcDir}`);
  process.exit(1);
}

// recursive copy creates destDir and its parents as needed.
cpSync(srcDir, destDir, { recursive: true });
