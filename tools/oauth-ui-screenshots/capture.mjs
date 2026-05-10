#!/usr/bin/env node
/**
 * Capture OAuth UI screenshots for PR review.
 *
 * Boots the UI Vite dev server and uses Playwright (chromium) to render the
 * `/tests/screenshots/oauth-ui` dev-only route, which renders all six static
 * fixtures (see `ui/src/pages/__screenshots__/OauthUiScreenshots.tsx`). One
 * PNG per `[data-screenshot-id]` section is written to
 * `docs/screenshots/oauth-ui/`.
 *
 * Usage:
 *   node tools/oauth-ui-screenshots/capture.mjs
 *
 * Idempotent — overwrites existing PNGs.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI_DIR = path.join(REPO_ROOT, "ui");
const OUTPUT_DIR = path.join(REPO_ROOT, "docs", "screenshots", "oauth-ui");
const PORT = Number(process.env.OAUTH_UI_SCREENSHOT_PORT ?? 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOT_PATH = "/tests/screenshots/oauth-ui";

const SECTIONS = [
  "01-empty-state",
  "02-providers-no-connections",
  "03-active-connection",
  "04-drawer-active",
  "05-drawer-disconnect-confirm",
  "06-envvar-oauth-binding",
];

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server at ${url} never became ready`);
}

async function startDevServer() {
  const proc = spawn(
    "pnpm",
    ["vite", "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"],
    {
      cwd: UI_DIR,
      env: { ...process.env, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout?.on("data", (chunk) => {
    process.stdout.write(`[vite] ${chunk}`);
  });
  proc.stderr?.on("data", (chunk) => {
    process.stderr.write(`[vite] ${chunk}`);
  });
  return proc;
}

async function captureScreenshots() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[browser console error] ${msg.text()}`);
      }
    });
    await page.goto(`${BASE_URL}${SCREENSHOT_PATH}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`[data-screenshot-id="${SECTIONS[0]}"]`, { timeout: 15_000 });

    for (const section of SECTIONS) {
      const locator = page.locator(`[data-screenshot-id="${section}"]`);
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const filename = path.join(OUTPUT_DIR, `${section}.png`);
      await locator.screenshot({ path: filename });
      console.log(`Wrote ${path.relative(REPO_ROOT, filename)}`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`[capture] booting vite dev server on ${BASE_URL}`);
  const server = await startDevServer();
  try {
    await waitForServer(BASE_URL);
    console.log(`[capture] vite ready, capturing screenshots`);
    await captureScreenshots();
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
