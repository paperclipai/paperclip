import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { precompressedUiAssets, staticUiCompression } from "../middleware/static-ui-compression.js";

let dir: string;
const js = "console.log('x');".repeat(200);

function app() {
  const server = express();
  server.use("/assets", precompressedUiAssets(dir));
  server.use(staticUiCompression());
  server.use("/assets", express.static(dir, { maxAge: "1y", immutable: true }));
  return server;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-assets-"));
  fs.writeFileSync(path.join(dir, "index-abc.js"), js);
  fs.writeFileSync(path.join(dir, "index-abc.js.br"), zlib.brotliCompressSync("FROM-BR"));
  fs.writeFileSync(path.join(dir, "index-abc.js.gz"), zlib.gzipSync("FROM-GZ"));
  fs.writeFileSync(path.join(dir, "plain-def.js"), js);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("precompressedUiAssets", () => {
  it("serves the brotli copy when accepted", async () => {
    const res = await request(app()).get("/assets/index-abc.js").set("Accept-Encoding", "gzip, br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toContain("Accept-Encoding");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toBe("FROM-BR");
  });

  it("falls back to gzip, then to the regular path", async () => {
    const gz = await request(app()).get("/assets/index-abc.js").set("Accept-Encoding", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.text).toBe("FROM-GZ");
    const identity = await request(app()).get("/assets/index-abc.js").set("Accept-Encoding", "identity");
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.text).toBe(js);
  });

  it("respects q=0 and byte ranges", async () => {
    const refused = await request(app()).get("/assets/index-abc.js").set("Accept-Encoding", "br;q=0");
    expect(refused.headers["content-encoding"]).toBeUndefined();
    const ranged = await request(app()).get("/assets/index-abc.js").set("Accept-Encoding", "br").set("Range", "bytes=0-9");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-encoding"]).toBeUndefined();
  });

  it("leaves assets without a precompressed copy to dynamic compression", async () => {
    const res = await request(app()).get("/assets/plain-def.js").set("Accept-Encoding", "br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
  });

  it("never escapes the assets directory", async () => {
    const res = await request(app()).get("/assets/..%2f..%2fetc%2fpasswd").set("Accept-Encoding", "br");
    expect(res.headers["content-encoding"]).not.toBe("br");
    expect(res.status).toBe(404);
  });
});
