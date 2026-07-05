#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOnly = process.argv.includes("--source-only");

const fontFiles = [
  "InterVariable.woff2",
  "InterVariable-Italic.woff2",
];

const noticeRequiredText = [
  "# Bundled UI Fonts",
  "Inter",
  "v4.1",
  "SIL Open Font License 1.1",
  "InterVariable.woff2",
  "InterVariable-Italic.woff2",
];

const locations = [
  {
    label: "source",
    dir: path.join(repoRoot, "ui", "public", "fonts"),
  },
];

const failures = [];

if (!sourceOnly) {
  locations.push({
    label: "build output",
    dir: path.join(repoRoot, "ui", "dist", "fonts"),
  });
}

function fail(message) {
  failures.push(message);
}

function verifyFontFile(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label}: missing ${path.relative(repoRoot, filePath)}`);
    return;
  }

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    fail(`${label}: expected file at ${path.relative(repoRoot, filePath)}`);
    return;
  }

  const header = readFileSync(filePath, { encoding: null }).subarray(0, 4).toString("ascii");
  if (header !== "wOF2") {
    fail(`${label}: ${path.relative(repoRoot, filePath)} is not a WOFF2 file`);
  }
}

function verifyNotice(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label}: missing ${path.relative(repoRoot, filePath)}`);
    return;
  }

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    fail(`${label}: expected file at ${path.relative(repoRoot, filePath)}`);
    return;
  }

  const body = readFileSync(filePath, "utf8");
  for (const expected of noticeRequiredText) {
    if (!body.includes(expected)) {
      fail(`${label}: NOTICE.md is missing expected text: ${expected}`);
    }
  }
}

function verifyCssReferences() {
  const cssPath = path.join(repoRoot, "ui", "src", "index.css");
  if (!existsSync(cssPath)) {
    fail(`source: missing ${path.relative(repoRoot, cssPath)}`);
    return;
  }

  const css = readFileSync(cssPath, "utf8");
  for (const fileName of fontFiles) {
    const reference = `url("../fonts/${fileName}")`;
    if (!css.includes(reference)) {
      fail(`source: ${path.relative(repoRoot, cssPath)} is missing ${reference}`);
    }
  }

  if (!css.includes('--font-sans: "InterVariable"')) {
    fail(`source: ${path.relative(repoRoot, cssPath)} does not wire InterVariable into --font-sans`);
  }
}

for (const location of locations) {
  if (!existsSync(location.dir)) {
    fail(`${location.label}: missing ${path.relative(repoRoot, location.dir)}/`);
    continue;
  }

  for (const fileName of fontFiles) {
    verifyFontFile(path.join(location.dir, fileName), location.label);
  }

  verifyNotice(path.join(location.dir, "NOTICE.md"), location.label);
}

verifyCssReferences();

if (failures.length > 0) {
  console.error("Bundled UI font asset check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

const checkedLocations = sourceOnly
  ? "ui/public/fonts"
  : "ui/public/fonts and ui/dist/fonts";
console.log(`Bundled UI font assets verified in ${checkedLocations}.`);
