import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const PORT = 4178;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

const server = createServer((req, res) => {
  let pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/" || pathname === "") pathname = "/dev/index.html";

  const filePath = path.join(packageRoot, pathname);
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(path.resolve(packageRoot))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  if (!existsSync(normalized) || !statSync(normalized).isFile()) {
    res.writeHead(404); res.end("Not found"); return;
  }

  const ext = path.extname(normalized);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  createReadStream(normalized).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  GitHub KPI plugin dev preview:\n`);
  console.log(`    http://127.0.0.1:${PORT}\n`);
  console.log(`  Serving from: ${packageRoot}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
