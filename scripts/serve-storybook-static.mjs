#!/usr/bin/env node
// Built Storybook plus the real, public on-demand avatar endpoint.
// Uses an isolated disposable cache; no company database or credentials.
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const { register } = await import(serverRequire.resolve("tsx/esm/api"));
register();
const express = serverRequire("express");
const { agentAvatarRoutes } = await import("../server/src/routes/agent-avatars.ts");
const { createAgentAvatarService } = await import("../server/src/services/agent-avatars.ts");
const { createLocalDiskStorageProvider } = await import("../server/src/storage/local-disk-provider.ts");
const cache = await mkdtemp(join(tmpdir(), "paperclip-storybook-avatars-"));
const avatars = createAgentAvatarService(createLocalDiskStorageProvider(cache));
const api = express();
api.use("/api", agentAvatarRoutes(avatars));
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/agent-avatars/")) { api(req, res); return; }
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

async function shutdown() {
  server.close();
  server.closeAllConnections();
  await avatars.close();
  await rm(cache, { recursive: true, force: true });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
