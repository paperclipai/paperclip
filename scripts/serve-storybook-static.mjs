#!/usr/bin/env node
// Tiny dependency-free static file server for the built Storybook
// (ui/storybook-static). Used by the visual snapshot suite's webServer so we
// don't add an http-server dependency.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "ui",
  "storybook-static",
);
const portArgIndex = process.argv.indexOf("--port");
const explicitPort =
  portArgIndex >= 0 &&
  process.argv[portArgIndex + 1] &&
  !process.argv[portArgIndex + 1].startsWith("--")
    ? process.argv[portArgIndex + 1]
    : null;
const portSource = explicitPort ?? process.env.PORT ?? 6106;
const port = Number(portSource);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid Storybook static server port: ${portSource}`);
  process.exit(1);
}

if (!existsSync(join(root, "index.html"))) {
  console.error(`No built Storybook at ${root}. Run \`pnpm build-storybook\` first.`);
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
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  let filePath = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
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
  console.log(`storybook-static served at http://localhost:${port}`);
});
