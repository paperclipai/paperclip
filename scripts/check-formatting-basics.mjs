#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".sql",
  ".sh",
  ".txt",
  ".css",
  ".html",
]);

const requestedFiles = process.argv.slice(2);
const candidateFiles =
  requestedFiles.length > 0
    ? requestedFiles
    : execSync("git ls-files", { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

const files = candidateFiles.filter((path) => {
  const idx = path.lastIndexOf(".");
  if (idx === -1) return false;
  return textExtensions.has(path.slice(idx));
});

const violations = [];
for (const path of files) {
  const body = readFileSync(path, "utf8");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/\s+$/.test(line) && line.length > 0) {
      violations.push(`${path}:${i + 1} trailing whitespace`);
      break;
    }
  }
  if (body.includes("\r\n")) {
    violations.push(`${path}: contains CRLF line endings`);
  }
}

if (violations.length > 0) {
  console.error("Basic formatting checks failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Formatting baseline passed for ${files.length} tracked text files.`);
