#!/usr/bin/env node
/**
 * Screenshot utility for Paperclip UI.
 *
 * Reads the board token from ~/.paperclip/auth.json and injects it as a
 * Bearer header so Playwright can access authenticated pages.
 *
 * Usage:
 *   node scripts/screenshot.cjs <url-or-path> [output.png] [--width 1280] [--height 800] [--wait 2000]
 *
 * Examples:
 *   node scripts/screenshot.cjs /PAPA/agents/cto/instructions /tmp/shot.png
 *   node scripts/screenshot.cjs http://localhost:5173/PAPA/agents/cto/instructions
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// --- CLI args -----------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const val = args.splice(i, 2)[1];
  return Number.isNaN(Number(val)) ? fallback : Number(val);
}
const width = flag("width", 1280);
const height = flag("height", 800);
const waitMs = flag("wait", 2000);

const rawUrl = args[0];
const outPath = args[1] || "/tmp/paperclip-screenshot.png";

if (!rawUrl) {
  console.error("Usage: node scripts/screenshot.cjs <url-or-path> [output.png]");
  process.exit(1);
}

// --- Auth ----------------------------------------------------------------
function loadBoardToken() {
  const authPath = path.resolve(os.homedir(), ".paperclip/auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const creds = auth.credentials || {};
    const entry = Object.values(creds)[0];
    if (entry && entry.token && entry.apiBase) return { token: entry.token, apiBase: entry.apiBase };
  } catch (_) {
    // ignore
  }
  return null;
}

const cred = loadBoardToken();
if (!cred) {
  console.error("No board token found in ~/.paperclip/auth.json");
  process.exit(1);
}

// Resolve URL — if it starts with / treat as path relative to apiBase
const url = rawUrl.startsWith("http") ? rawUrl : `${cred.apiBase}${rawUrl}`;

// Validate URL before launching browser
const origin = new URL(url).origin;

// --- Screenshot ----------------------------------------------------------
(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height },
    });

    const page = await context.newPage();
    // Scope the auth header to the Paperclip origin only
    await page.route(`${origin}/**`, async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), Authorization: `Bearer ${cred.token}` },
      });
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`Saved: ${outPath}`);
  } catch (err) {
    console.error(`Screenshot failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
