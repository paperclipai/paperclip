import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../src/server";

const VALID_CONFIG = {
  port: 0,
  roots: ["/Users/foo"],
  allowedOrigins: ["http://localhost:3100", "https://company.whitestag.ai"],
};

describe("server CORS", () => {
  let running: RunningServer;

  afterEach(async () => {
    await running?.close();
  });

  async function start() {
    running = await createServer({ config: VALID_CONFIG, port: 0 });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it("OPTIONS preflight from allowed origin returns 204 with ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://localhost:3100",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3100");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
  });

  it("OPTIONS preflight from disallowed origin returns 403 without ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("regular GET /health from allowed origin sets ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`, {
      headers: { "Origin": "https://company.whitestag.ai" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://company.whitestag.ai");
  });

  it("GET /health without Origin works (e.g. installer health-check)", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});
