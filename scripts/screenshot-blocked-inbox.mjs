#!/usr/bin/env node
// Capture screenshots of the Blocked Inbox storybook stories.
// Usage: node scripts/screenshot-blocked-inbox.mjs <storybook-static-dir> <output-dir>

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";

async function main() {
  const [, , staticDir, outDir] = process.argv;
  if (!staticDir || !outDir) {
    console.error("usage: node scripts/screenshot-blocked-inbox.mjs <storybook-static-dir> <output-dir>");
    process.exit(1);
  }
  await fs.mkdir(outDir, { recursive: true });
  const absStaticDir = path.resolve(staticDir);

  const server = http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath.endsWith("/")) urlPath += "iframe.html";
      const filePath = path.resolve(absStaticDir, `.${urlPath}`);
      if (!filePath.startsWith(absStaticDir + path.sep) && filePath !== absStaticDir) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const buf = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".map": "application/json",
      }[ext] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      res.end(buf);
    } catch (err) {
      res.writeHead(404);
      res.end(String(err));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/iframe.html`;

  const browser = await chromium.launch();
  try {
    const stories = [
      { id: "product-inbox-blocked-tab--desktop-loaded", file: "01-desktop-loaded.png", width: 1440, height: 1100, dark: false },
      { id: "product-inbox-blocked-tab--desktop-loaded", file: "02-desktop-loaded-dark.png", width: 1440, height: 1100, dark: true },
      { id: "product-inbox-blocked-tab--desktop-with-search", file: "03-desktop-with-search.png", width: 1440, height: 800, dark: false },
      { id: "product-inbox-blocked-tab--mobile-layout", file: "04-mobile-layout.png", width: 390, height: 1100, dark: false },
      { id: "product-inbox-blocked-tab--reason-chip-catalog", file: "05-reason-chip-catalog.png", width: 900, height: 600, dark: false },
      { id: "product-inbox-blocked-tab--empty-state", file: "06-empty-state.png", width: 900, height: 500, dark: false },
    ];

    for (const story of stories) {
      const ctx = await browser.newContext({
        viewport: { width: story.width, height: story.height },
        deviceScaleFactor: 2,
        colorScheme: story.dark ? "dark" : "light",
      });
      const page = await ctx.newPage();
      const url = `${baseUrl}?id=${story.id}&viewMode=story`;
      await page.goto(url, { waitUntil: "networkidle" });
      // Force light/dark class on <html> for tailwind dark mode tokens
      await page.evaluate((dark) => {
        const html = document.documentElement;
        html.classList.toggle("dark", dark);
        html.style.colorScheme = dark ? "dark" : "light";
      }, story.dark);
      await page.waitForTimeout(500);
      const out = path.join(outDir, story.file);
      await page.screenshot({ path: out, fullPage: true });
      console.log("wrote", out);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
