import { once } from "node:events";
import dns from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals } from "../realtime/runner-prp-ws.js";
import { resolveLocalRuntimeApiUrl } from "../runtime-api.js";
import { createPaperclipHttpServer } from "./server.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

async function guardedNativeRead(bindHost: string, configuredHost = bindHost) {
  const app = express();
  app.use(privateHostnameGuard({ enabled: true, bindHost: configuredHost, allowedHostnames: [] }));
  app.get("/api/native-read", (req, res) => {
    res.status(req.header("authorization") === "Bearer synthetic-readonly-run-token" ? 200 : 401).json({ readonly: true });
  });
  const server = createPaperclipHttpServer(app, { apiUrl: "https://advertised.example.test" });
  try {
    server.listen(0, bindHost);
    await once(server, "listening");
    const url = `${resolveLocalRuntimeApiUrl()}/api/native-read`;
    const authenticated = await fetch(url, { headers: { Authorization: "Bearer synthetic-readonly-run-token" } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ readonly: true });
    const unauthenticated = await fetch(url);
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("Paperclip HTTP server runner transport", () => {
  afterEach(() => {
    runnerPrpWebSocketInternals.resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers native runner authority without a separate startup call", async () => {
    const server = createPaperclipHttpServer((_req, res) => res.end("ok"), {
      apiUrl: "http://127.0.0.1:3210",
    });
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = resolveLocalRuntimeApiUrl();
    const authority = await registerRunnerPrpAuthority({
      companyId: "company-1", runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });
    expect(authority.connectUrl).toBe(`${origin.replace("http:", "ws:")}/api/runner/v1/connect/${runId}`);
    await authority.release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("serves HTTP and rejects an unregistered runner over the real listener", async () => {
    const server = createPaperclipHttpServer((_req, res) => res.end("ready"), {
      apiUrl: "http://127.0.0.1:3210",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Listener not bound");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(await (await fetch(origin)).text()).toBe("ready");
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${origin}/api/runner/v1/connect/00000000-0000-4000-8000-000000000778`, {
          headers: { connection: "Upgrade", upgrade: "websocket" },
        }, res => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("Runner upgrade was not handled")));
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("refuses native endpoints before listen and after close despite advertised fallback URLs", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "https://advertised.example.test");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "controller.example.test");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "3210");
    const server = createPaperclipHttpServer((_req, res) => res.end("ready"), {
      apiUrl: "https://advertised.example.test",
    });
    const binding = { companyId: "company-1", runId: "00000000-0000-4000-8000-000000000779",
      authority: {} as DurablePrpControlPlane };
    expect(() => resolveLocalRuntimeApiUrl()).toThrow();
    await expect(registerRunnerPrpAuthority(binding)).rejects.toThrow();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      expect(resolveLocalRuntimeApiUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(() => resolveLocalRuntimeApiUrl()).toThrow();
    await expect(registerRunnerPrpAuthority(binding)).rejects.toThrow();
    expect(process.env.PAPERCLIP_API_URL).toBe("https://advertised.example.test");
  });

  it("uses the actual numeric bind for bearer REST and PRP without a second hostname lookup", async () => {
    const hostname = "controller-bind.example.test";
    let lookups = 0;
    vi.spyOn(dns, "lookup").mockImplementation(((host, options, callback) => {
      if (host !== hostname || typeof options !== "object" || options.all !== true) {
        throw new Error("Expected only the listener's all-address lookup");
      }
      // node:net's listen path requests all addresses; dns.lookup's overloaded
      // declaration otherwise contextualizes this callback as its IPv4 form.
      const lookedUp = callback as (error: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => void;
      lookups++;
      if (lookups > 1) return lookedUp(Object.assign(new Error("Unexpected second DNS authority"), { code: "ENOTFOUND" }));
      lookedUp(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as typeof dns.lookup);
    vi.stubEnv("PAPERCLIP_API_URL", "https://advertised.example.test");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", hostname);
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "1");
    const server = createPaperclipHttpServer((req, res) => {
      res.statusCode = req.headers.authorization === "Bearer synthetic-run-token" ? 200 : 401;
      res.end("local-controller");
    }, { apiUrl: "https://advertised.example.test" });
    const directory = await mkdtemp(join(tmpdir(), "paperclip-bound-prp-"));
    const runId = "00000000-0000-4000-8000-000000000780";
    const authority = new DurablePrpControlPlane({ stateDirectory: directory,
      identity: { runnerInstanceId: "bound-runner", environmentLeaseId: "bound-lease", normalizedSessionId: "bound-session", runId, turnId: "bound-turn", itemId: "bound-item" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    let registration: Awaited<ReturnType<typeof registerRunnerPrpAuthority>> | undefined;
    try {
      server.listen(0, hostname);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP bind");
      const expected = `http://127.0.0.1:${address.port}`;
      expect(resolveLocalRuntimeApiUrl()).toBe(expected);
      expect(await (await fetch(resolveLocalRuntimeApiUrl(), { headers: { Authorization: "Bearer synthetic-run-token" } })).text()).toBe("local-controller");
      registration = await registerRunnerPrpAuthority({ companyId: "company-1", runId, authority });
      expect(registration.connectUrl).toBe(`${expected.replace("http:", "ws:")}/api/runner/v1/connect/${runId}`);
      const upgraded = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(registration!.connectUrl.replace("ws:", "http:"), { headers: {
          Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        } });
        req.once("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.once("response", res => { res.resume(); resolve(res.statusCode); });
        req.once("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("PRP upgrade unavailable")));
        req.end();
      });
      expect(upgraded).toBe(101);
      expect(lookups).toBe(1);
      expect(process.env.PAPERCLIP_API_URL).toBe("https://advertised.example.test");
    } finally {
      await registration?.release();
      await authority.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["0.0.0.0", "127.0.0.1"], ["::", "[::1]"], ["::1", "[::1]"],
  ])("uses matching loopback for a real %s bind", async (host, connectHost) => {
    const server = createPaperclipHttpServer((_req, res) => res.end("bound"), { apiUrl: "https://advertised.example.test" });
    server.listen(0, host);
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP bind");
      expect(resolveLocalRuntimeApiUrl()).toBe(`http://${connectHost}:${address.port}`);
      expect(await (await fetch(resolveLocalRuntimeApiUrl())).text()).toBe("bound");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("fails closed for unavailable or nonnumeric bound addresses and competing listeners", async () => {
    const first = createPaperclipHttpServer((_req, res) => res.end("first"), { apiUrl: "http://ignored.example.test" });
    const second = createPaperclipHttpServer((_req, res) => res.end("second"), { apiUrl: "http://ignored.example.test" });
    first.listen(0, "127.0.0.1");
    await once(first, "listening");
    try {
      const address = vi.spyOn(first, "address");
      for (const unavailable of [null, "/tmp/not-tcp.sock", { address: "changed.example.test", family: "IPv4", port: 3210 }]) {
        address.mockReturnValueOnce(unavailable);
        expect(() => resolveLocalRuntimeApiUrl()).toThrow();
      }
      second.listen(0, "127.0.0.1");
      await once(second, "listening");
      expect(() => resolveLocalRuntimeApiUrl()).toThrow("local_runtime_api_listener_ambiguous");
      await expect(registerRunnerPrpAuthority({ companyId: "company-1", runId: "00000000-0000-4000-8000-000000000781", authority: {} as DurablePrpControlPlane }))
        .rejects.toThrow("local_runtime_api_listener_ambiguous");
    } finally {
      await Promise.all([first, second].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("routes a guarded native read through the real %s listener", async host => {
    await guardedNativeRead(host);
  });

  it("routes a guarded native read after a configured hostname binds a local interface", async context => {
    const address = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
      .find(entry => !entry.internal && entry.family === "IPv4" && !entry.address.startsWith("127."))?.address;
    if (!address) { context.skip(); return; }
    const hostname = "guarded-controller.example.test";
    let lookups = 0;
    vi.spyOn(dns, "lookup").mockImplementation(((host, options, callback) => {
      if (host !== hostname || typeof options !== "object" || options.all !== true) throw new Error("Unexpected lookup in local fixture");
      const lookedUp = callback as (error: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => void;
      if (++lookups !== 1) throw new Error("Repeated hostname lookup in local fixture");
      lookedUp(null, [{ address, family: 4 }]);
    }) as typeof dns.lookup);
    await guardedNativeRead(hostname);
    expect(lookups).toBe(1);
  });
});
