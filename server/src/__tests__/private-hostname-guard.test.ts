import { describe, expect, it, vi } from "vitest";
import express from "express";
import type os from "node:os";
import request from "supertest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";
const lanIp = "192.168.6.178";
const lanHostname = "paperclip-lan.example.test";
const lanNetworkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  en0: [{
    address: lanIp,
    family: "IPv4",
    internal: false,
    netmask: "255.255.255.0",
    cidr: `${lanIp}/24`,
    mac: "00:00:00:00:00:00",
  }],
};

function createApp(opts: {
  enabled: boolean;
  allowedHostnames?: string[];
  bindHost?: string;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
      networkInterfacesMap: opts.networkInterfacesMap,
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

  it("allows the configured wildcard LAN bind hostname", async () => {
    const app = createApp({ enabled: true, bindHost: "0.0.0.0" });
    const res = await request(app).get("/api/health").set("Host", "0.0.0.0:3100");
    expect(res.status).toBe(200);
  });

  it("allows the actual LAN address and intended hostname for a wildcard bind", async () => {
    const app = createApp({
      enabled: true,
      bindHost: "0.0.0.0",
      allowedHostnames: [lanHostname],
      networkInterfacesMap: lanNetworkInterfaces,
    });

    const lanIpResponse = await request(app).get("/api/health").set("Host", `${lanIp}:3100`);
    const hostnameResponse = await request(app).get("/api/health").set("Host", `${lanHostname}:3100`);
    const unrelatedHostResponse = await request(app).get("/api/health").set("Host", "192.168.6.179:3100");

    expect(lanIpResponse.status).toBe(200);
    expect(hostnameResponse.status).toBe(200);
    expect(unrelatedHostResponse.status).toBe(403);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`);
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
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
      expect.stringContaining(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`),
    );
  }, 20_000);
});
