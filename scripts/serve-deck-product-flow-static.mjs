#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = join(repoRoot, "ui", "deck-product-flow-static");
const portArgIndex = process.argv.indexOf("--port");
const explicitPort =
  portArgIndex >= 0 &&
  process.argv[portArgIndex + 1] &&
  !process.argv[portArgIndex + 1].startsWith("--")
    ? process.argv[portArgIndex + 1]
    : null;
const portSource = explicitPort ?? process.env.PORT ?? 6173;
const port = Number(portSource);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid deck product flow static server port: ${portSource}`);
  process.exit(1);
}

if (!existsSync(join(root, "deck-product-flow.html"))) {
  console.error(`No built deck product flow artifact at ${root}. Run \`pnpm build:deck-product-flow\` first.`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  let filePath = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "deck-product-flow.html");
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`deck-product-flow-static served at http://localhost:${port}`);
});
