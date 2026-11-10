import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const execute = promisify(execFile);

/** A real production UI build, isolated static listener, and read-only API proxy.
 * It shares only the already-owned test API; it never starts another database. */
export async function startOwnedProductionUi(ctx: ChatCatalogContext) {
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root) throw new Error("Production route proof requires the owned attempt directory");
  const sourceRevision = process.env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA;
  if (!sourceRevision || !/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Production UI proof requires the pinned full candidate source revision");
  const directory = await mkdtemp(path.join(await realpath(root), "production-ui-"));
  const repository = fileURLToPath(new URL("../../../", import.meta.url)), out = path.join(directory, "dist");
  try {
    await execute(process.execPath, [path.join(repository, "ui/node_modules/vite/bin/vite.js"), "build", "--mode", "production", "--outDir", out], {
      cwd: path.join(repository, "ui"), timeout: 180_000, maxBuffer: 2_097_152,
      env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "production", PAPERCLIP_TELEMETRY_DISABLED: "1", PAPERCLIP_BUILD_COMMIT: sourceRevision },
    });
  } catch { await rm(directory, { recursive: true }); throw new Error("Owned production UI build failed; private build output withheld"); }
  async function inventory(current: string): Promise<Array<{ path: string; sha256: string }>> {
    const rows: Array<{ path: string; sha256: string }> = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) rows.push(...await inventory(file));
      else if (entry.isFile()) rows.push({ path: path.relative(out, file), sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
    }
    return rows;
  }
  const files = (await inventory(out)).sort((a, b) => a.path.localeCompare(b.path));
  const buildSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
  const server = createServer(async (request, response) => {
    try {
      const route = new URL(request.url ?? "/", "http://owned.invalid");
      if (route.pathname.startsWith("/api/")) {
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(403).end(); return; }
        const upstream = await fetch(new URL(route.pathname + route.search, ctx.input.api.baseURL), { redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) } });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
        response.end(Buffer.from(await upstream.arrayBuffer())); return;
      }
      const candidate = path.resolve(out, "." + decodeURIComponent(route.pathname));
      if (!candidate.startsWith(out + path.sep)) { response.writeHead(404).end(); return; }
      let file = candidate;
      let body: Buffer;
      try { body = await readFile(file); }
      catch { file = path.join(out, "index.html"); body = await readFile(file); }
      response.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "x-eval-production-ui-build": buildSha256 });
      response.end(body);
    } catch { response.writeHead(502).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned production UI listener has no address");
  return { origin: `http://127.0.0.1:${address.port}`, buildSha256, sourceRevision, files,
    stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true }); } };
}
