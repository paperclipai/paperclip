#!/usr/bin/env node
// Capture the PAP-16650 Notion connection-flow Storybook stories.
// Usage: node scripts/screenshot-notion-connect-flow.mjs <storybook-static-dir> <output-dir>

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";

async function main() {
  const [, , staticDir, outDir] = process.argv;
  if (!staticDir || !outDir) {
    console.error(
      "usage: node scripts/screenshot-notion-connect-flow.mjs <storybook-static-dir> <output-dir>",
    );
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
      const mime =
        {
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
    } catch (error) {
      res.writeHead(404);
      res.end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start screenshot server");
  const baseUrl = `http://127.0.0.1:${address.port}/iframe.html`;

  const stories = [
    ["browse-entry", "01-browse-entry.png"],
    ["connect-entry", "02-connect-entry.png"],
    ["in-flight", "03-in-flight.png"],
    ["connected", "04-connected.png"],
    ["connect-error", "05-connect-error.png"],
    ["reconnect-required", "06-reconnect-required.png"],
  ];

  const browser = await chromium.launch();
  try {
    for (const [story, file] of stories) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await page.goto(
        `${baseUrl}?id=apps-notion-mcp-connect-flow-pap-16650--${story}&viewMode=story`,
        { waitUntil: "networkidle" },
      );
      await page.waitForTimeout(500);
      const out = path.join(outDir, file);
      await page.screenshot({ path: out, fullPage: true });
      console.log("wrote", out);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
