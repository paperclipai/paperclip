import http from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startRunnerWssTunnel } from "./runner-wss-tunnel.js";
import { createRunnerWssRelay } from "./runner-wss-relay.js";

import { describe, expect, it } from "vitest";
import { allowsRunnerUpgrade } from "./runner-wss-tunnel.js";
describe("runner-only test tunnel", () => {
  it("allows only the exact authenticated runner WebSocket route", () => {
    expect(allowsRunnerUpgrade("GET", "/api/runner/v1/connect/1234-abcd")).toBe(true);
    for (const url of ["/", "/api/companies", "/api/instance/settings", "/api/runner/v1/connect/../companies", "/api/runner/v1/connect/a?token=x", "/api/runner/v1/connect/a/", "/api/runner/v1/connect/%2fapi"]) {
      expect(allowsRunnerUpgrade("GET", url)).toBe(false);
    }
    expect(allowsRunnerUpgrade("POST", "/api/runner/v1/connect/a")).toBe(false);
  });
});


it("the shared relay forwards only registered runner upgrades, preserves auth, and revokes closed registrations", async () => {
  const registryDirectory = await mkdtemp(path.join(tmpdir(), "runner-relay-test-"));
  const target = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
  const observed: Array<{ url?: string; authorization?: string }> = [];
  target.on("upgrade", (request, socket) => {
    observed.push({ url: request.url, authorization: request.headers.authorization });
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const relay = createRunnerWssRelay(registryDirectory);
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  const relayPort = (relay.address() as AddressInfo).port;
  const tunnel = await startRunnerWssTunnel(undefined, (target.address() as AddressInfo).port,
    { publicUrl: "wss://relay.example.test", registryDirectory });
  const prefix = new URL(tunnel.publicUrl).pathname;
  const request = (url: string, upgrade = false) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: relayPort, path: url,
      headers: upgrade ? { Connection: "Upgrade", Upgrade: "websocket", Authorization: "Bearer fixture-capability" } : {} }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    });
    req.on("error", reject); req.end();
  });
  try {
    expect(await request(`${prefix}/api/runner/v1/connect/run-id`, true)).toBe(401);
    expect(observed).toEqual([{ url: "/api/runner/v1/connect/run-id", authorization: "Bearer fixture-capability" }]);
    for (const url of ["/api/companies", `${prefix}/api/companies`, `${prefix}/api/runner/v1/connect/run-id?token=x`, `/00000000-0000-0000-0000-000000000000/api/runner/v1/connect/run-id`]) {
      expect(await request(url, true)).toBe(404);
    }
    expect(await request(`${prefix}/api/runner/v1/connect/run-id`)).toBe(404);
    expect(observed).toHaveLength(1);
    await tunnel.close();
    expect(await readdir(registryDirectory)).toEqual([]);
    expect(await request(`${prefix}/api/runner/v1/connect/run-id`, true)).toBe(404);
  } finally {
    await tunnel.close();
    await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => relay.close(() => resolve()))]);
    await rm(registryDirectory, { recursive: true, force: true });
  }
});
