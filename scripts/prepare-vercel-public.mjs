#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDist = path.join(rootDir, "ui", "dist");
const publicDir = path.join(rootDir, "public");

if (!fs.existsSync(path.join(uiDist, "index.html"))) {
  console.error(`Error: UI build output missing at ${uiDist}/index.html`);
  process.exit(1);
}

fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(uiDist, publicDir, { recursive: true });
console.log(`Copied ${uiDist} to ${publicDir}`);
