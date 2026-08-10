#!/usr/bin/env node
// Capture screenshots of the Next Action storybook stories.
// Usage: node scripts/screenshot-next-action.mjs <storybook-static-dir> <output-dir>

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";

async function main() {
  const [, , staticDir, outDir] = process.argv;
  if (!staticDir || !outDir) {
    console.error("usage: node scripts/screenshot-next-action.mjs <storybook-static-dir> <output-dir>");
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

  const browser = await chromium.launch({
    executablePath: process.env.SCREENSHOT_CHROME || undefined,
  });
  try {
    const base = "product-next-action";
    const width = 760;
    const height = 460;
    const stories = [
      { id: `${base}--blocked-tree`, file: "01-blocked-tree.png" },
      { id: `${base}--blocked-tree`, file: "02-blocked-tree-dark.png", dark: true },
      { id: `${base}--blocked-tree-terminal-gate`, file: "03-terminal-gate.png" },
      { id: `${base}--recovery-lane`, file: "04-recovery-lane.png" },
      { id: `${base}--recovery-lane-scheduled-run`, file: "05-recovery-scheduled-run.png" },
      { id: `${base}--needs-disposition`, file: "06-needs-disposition.png" },
      { id: `${base}--awaiting-decision`, file: "07-awaiting-decision.png" },
      { id: `${base}--diagnostics-error`, file: "08-diagnostics-error.png" },
    ];

    for (const story of stories) {
      const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: story.dark ? "dark" : "light",
      });
      const page = await ctx.newPage();
      const url = `${baseUrl}?id=${story.id}&viewMode=story`;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate((dark) => {
        const html = document.documentElement;
        html.classList.toggle("dark", dark);
        html.style.colorScheme = dark ? "dark" : "light";
      }, Boolean(story.dark));
      await page.waitForTimeout(400);
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
