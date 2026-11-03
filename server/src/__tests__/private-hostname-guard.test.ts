import { describe, expect, it, vi } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";

function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
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
  it.each([
    ["IPv6 loopback", "[::1]:3100"],
    ["mapped loopback", "[::ffff:7f00:1]:3100"],
  ])("preserves %s admission", async (_name, host) => {
    expect((await request(createApp({ enabled: true })).get("/api/health").set("Host", host)).status).toBe(200);
  });

  it.each([
    { name: "same IPv4 socket", expected: 200 },
    { name: "loopback caller", remote: "127.0.0.2", expected: 200 },
    { name: "mapped socket forms", local: "::ffff:203.0.113.5", remote: "::ffff:127.0.0.1", expected: 200 },
    { name: "mapped Host", host: "[::ffff:cb00:7105]:3100", expected: 200 },
    { name: "IPv6 compression", host: "[2001:db8::a]:3100", local: "2001:db8:0:0:0:0:0:a", remote: "::1", expected: 200 },
    { name: "IPv6 same caller", host: "[2001:db8::a]:3100", local: "2001:db8::a", remote: "2001:db8::a", expected: 200 },
    { name: "remote caller", remote: "203.0.113.6", expected: 403 },
    { name: "foreign numeric Host", host: "203.0.113.6:3100", expected: 403 },
    { name: "unknown DNS Host", host: "unknown.example.test:3100", expected: 403 },
    { name: "missing local socket", local: undefined, expected: 403 },
    { name: "missing remote socket", remote: undefined, expected: 403 },
    { name: "nonnumeric local socket", local: "controller.example.test", expected: 403 },
    { name: "nonnumeric remote socket", remote: "localhost", expected: 403 },
    { name: "page route", path: "/dashboard", expected: 403 },
    { name: "API lookalike route", path: "/api-foreign", expected: 403 },
    { name: "userinfo Host", host: "user@203.0.113.5:3100", expected: 403 },
    { name: "Forwarded", headers: { forwarded: "for=127.0.0.1" }, expected: 403 },
    { name: "forwarded Host", headers: { "x-forwarded-host": "203.0.113.5:3100" }, expected: 403 },
    { name: "forwarded caller", headers: { "x-forwarded-for": "127.0.0.1" }, expected: 403 },
    { name: "forwarded protocol", headers: { "x-forwarded-proto": "http" }, expected: 403 },
    { name: "arbitrary forwarded metadata", headers: { "x-forwarded-extra": "" }, expected: 403 },
  ])("limits direct local API admission: $name", scenario => {
    const values = { host: "203.0.113.5:3100", local: "203.0.113.5", remote: "203.0.113.5", path: "/api/health", headers: {}, ...scenario };
    const headers: Record<string, string> = { host: values.host, ...values.headers };
    const req = { path: values.path, headers, header: (name: string) => headers[name.toLowerCase()], accepts: () => "json",
      socket: { localAddress: values.local, remoteAddress: values.remote } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    privateHostnameGuard({ enabled: true, allowedHostnames: [], bindHost: "configured.example.test" })(req, res, next);
    if (scenario.expected === 200) { expect(next).toHaveBeenCalledOnce(); expect(res.status).not.toHaveBeenCalled(); }
    else { expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403); }
  });

  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with a static remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    // The remediation command carries a static `<host>` placeholder. It never
    // interpolates the request Host header into the command.
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain(unknownHostname);
  });

  it("blocks unknown hostnames on page routes with a static plain-text remediation command", async () => {
    const middleware = privateHostnameGuard({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      bindHost: "0.0.0.0",
    });
    const req = {
      path: "/dashboard",
      header: (name: string) => (name.toLowerCase() === "host" ? `${unknownHostname}:3100` : undefined),
      accepts: () => "html",
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
    );
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining(unknownHostname));
  }, 20_000);

  it("does not reflect a hostile Host header into the remediation command", async () => {
    // An unauthenticated requester can send an invalid Host header that holds
    // shell metacharacters. `extractHostname` falls back to the raw header when
    // URL parsing fails. The 403 guidance must not echo that value, so an
    // operator or an agent cannot paste an attacker-controlled span into a
    // shell. Use a harmless, nonexistent command name inside the span.
    const hostileHost = "evil$(echo marker)host";
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", hostileHost);
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain("evil");
    expect(res.body?.error).not.toContain("$(");
    expect(res.body?.error).not.toContain("marker");
  });
});
