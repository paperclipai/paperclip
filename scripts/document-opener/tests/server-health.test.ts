import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../src/server";

describe("server /health", () => {
  let running: RunningServer;

  afterEach(async () => {
    await running?.close();
  });

  async function startWith(config: Parameters<typeof createServer>[0]["config"]) {
    running = await createServer({ config, port: 0 });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it("returns 503 when config is null", async () => {
    const base = await startWith(null);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not configured" });
  });

  it("returns 200 with roots when config is valid", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      version: "1",
      roots: ["/Users/foo"],
    });
  });

  it("returns 404 for unknown route", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("binds to 127.0.0.1 only", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});
