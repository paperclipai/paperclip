#!/usr/bin/env node
// Captures the BindingPicker storybook screenshot for PAP-2351 re-review.
// Boots a tiny static server over `ui/storybook-static` and screenshots the
// happy-path picker grid in dark mode at 1440x900 (matches the original
// PAP-2350 capture).

import { createRequire } from "node:module";
const localRequire = createRequire(import.meta.url);
const { chromium } = localRequire("playwright");
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const storybookRoot = path.join(repoRoot, "ui", "storybook-static");
const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "screenshots", "pap-2351");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        let filePath = path.join(rootDir, urlPath === "/" ? "index.html" : urlPath);
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          stat = null;
        }
        if (stat?.isDirectory()) {
          filePath = path.join(filePath, "index.html");
          stat = await fs.stat(filePath).catch(() => null);
        }
        if (!stat) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
        res.setHeader("cache-control", "no-cache");
        const data = await fs.readFile(filePath);
        res.end(data);
      } catch (err) {
        res.statusCode = 500;
        res.end(err.message);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const SHOTS = [
  {
    storyId: "product-secrets--binding-picker",
    label: "secrets-binding-picker",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
  },
];

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const { server, baseUrl } = await startStaticServer(storybookRoot);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const captured = [];
  try {
    for (const shot of SHOTS) {
      await page.setViewportSize(shot.viewport);
      const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(shot.storyId)}&viewMode=story&globals=theme:${shot.theme}`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      // Allow the storybook fixture to swap CompanyContext to the storybook id and
      // for the picker's useQuery to settle from cache.
      await page.waitForTimeout(1500);
      const dest = path.join(outDir, `${shot.label}.png`);
      await page.screenshot({ path: dest, fullPage: false });
      captured.push(dest);
      console.log("captured", dest);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ captured }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
