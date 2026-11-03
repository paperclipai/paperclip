import express from "express";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staticUiCompression } from "../middleware/static-ui-compression.js";

const source = "export const message = 'synthetic static UI fixture';\n".repeat(2000);
let root: string;
let server: ReturnType<typeof createServer>;
let port: number;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paperclip-static-compression-"));
  await writeFile(path.join(root, "app.js"), source);
  const app = express();
  app.get("/mcp/runner", (_req, res) => res.status(401).json({ error: "invalid_token" }));
  const ui = express.Router();
  ui.use(staticUiCompression());
  ui.use("/assets", express.static(root, { maxAge: "1y", immutable: true }));
  app.use(ui);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await rm(root, { recursive: true, force: true });
});

function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers, method }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("built UI compression", () => {
  it.each(["gzip", "br"])("compresses large JS with %s while preserving content and caching", async encoding => {
    const res = await get("/assets/app.js", { "Accept-Encoding": encoding });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe(encoding);
    expect(res.headers.vary).toContain("Accept-Encoding");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.body.length).toBeLessThan(Buffer.byteLength(source) / 4);
    expect((encoding === "br" ? brotliDecompressSync(res.body) : gunzipSync(res.body)).toString()).toBe(source);
  });
  it("keeps an uncompressed response for clients requesting identity", async () => {
    const res = await get("/assets/app.js", { "Accept-Encoding": "identity" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString()).toBe(source);
  });
  it("preserves byte ranges and conditional cache revalidation", async () => {
    const partial = await get("/assets/app.js", { "Accept-Encoding": "br, gzip", Range: "bytes=0-31" });
    expect(partial.status).toBe(206);
    expect(partial.headers["content-encoding"]).toBeUndefined();
    expect(partial.headers["content-range"]).toBe(`bytes 0-31/${Buffer.byteLength(source)}`);
    expect(partial.body.toString()).toBe(source.slice(0, 32));
    const cached = await get("/assets/app.js", { "Accept-Encoding": "gzip" });
    const fresh = await get("/assets/app.js", { "Accept-Encoding": "gzip", "If-None-Match": cached.headers.etag! });
    expect(fresh.status).toBe(304);
    expect(fresh.body.length).toBe(0);
    const head = await get("/assets/app.js", { "Accept-Encoding": "gzip" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });
  it("does not compress MCP responses or turn missing assets into HTML", async () => {
    const mcp = await get("/mcp/runner", { "Accept-Encoding": "gzip" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers["content-encoding"]).toBeUndefined();
    expect((await get("/assets/missing.js", { "Accept-Encoding": "gzip" })).status).toBe(404);
  });
});
