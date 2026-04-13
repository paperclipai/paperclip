import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const unknownHostname = "blocked-host.invalid";

async function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
  const { privateHostnameGuard } = await import("../middleware/private-hostname-guard.js");
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("privateHostnameGuard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests when disabled", async () => {
    const app = await createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = await createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`);
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/dashboard").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    expect(res.text).toContain(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`);
  }, 20_000);
});
