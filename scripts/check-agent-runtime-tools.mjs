#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function fail(message, detail) {
  console.error(`FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const qmd = spawnSync("qmd", ["--help"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (qmd.error) {
  fail("qmd is not available on PATH.", qmd.error.message);
}

if (qmd.status !== 0) {
  fail("qmd --help failed.", qmd.stderr || qmd.stdout);
}

try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  await browser.close();
} catch (error) {
  fail("Playwright Chromium could not launch.", error instanceof Error ? error.message : String(error));
}

console.log("PASS: qmd and Playwright Chromium launch are available.");
