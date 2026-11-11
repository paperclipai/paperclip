import { createServer, request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { observeIncomingHttpWindow, observedNoIncomingHttp } from "../../../scripts/sleep-qualification/evidence.mjs";
import { observeMaintenanceIncomingHttp } from "./helpers/maintenance/incoming-http-observation.js";
import { withMaintenanceProvider } from "./helpers/maintenance/server-harness.js";

it("counts a direct SQL-free health fetch without retaining credentials or changing its response", async () => {
  // This fixture has no database or outgoing client; its only work is answering HTTP.
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"status":"ok"}'); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  const capture = observeMaintenanceIncomingHttp(server);
  try {
    await withMaintenanceProvider(server, async origin => {
      const before = capture.snapshot(), startedAt = new Date().toISOString();
      expect(before).toMatchObject({ installed: true, valid: true, requests: 0 });
      expect(observedNoIncomingHttp(observeIncomingHttpWindow(before, before), { startedAt: before.observedAt, finishedAt: before.observedAt })).toBe(true);
      const response = await fetch(`${origin}/api/health?fixture=private-query`, { signal: AbortSignal.timeout(5_000), headers: { Authorization: "Bearer fixture-private-token" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      const finishedAt = new Date().toISOString(), after = capture.snapshot();
      expect(after).toMatchObject({ installed: true, valid: true, captureId: before.captureId });
      const observed = observeIncomingHttpWindow(before, after);
      expect(observed.requests).toBe(1);
      expect(observedNoIncomingHttp(observed, { startedAt, finishedAt })).toBe(false);
      expect(JSON.stringify(observed)).not.toMatch(/private-query|fixture-private-token|Authorization|\/api\/health/);
    });
  } finally { capture.dispose(); }
});

it("observes a genuinely request-free interval without making snapshot reads into HTTP", async () => {
  const server = createServer((_req, res) => res.end());
  server.on("upgrade", (_req, socket) => socket.destroy());
  const capture = observeMaintenanceIncomingHttp(server);
  try {
    await withMaintenanceProvider(server, async () => {
      const before = capture.snapshot(), startedAt = new Date().toISOString();
      capture.snapshot(); await setImmediate(); capture.snapshot();
      const finishedAt = new Date().toISOString(), after = capture.snapshot();
      expect(observeIncomingHttpWindow(before, after).requests).toBe(0);
      expect(observedNoIncomingHttp(observeIncomingHttpWindow(before, after), { startedAt, finishedAt })).toBe(true);
      // This short boundary test does not claim the configured case's 90-second quiet proof.
    });
  } finally { capture.dispose(); }
});

it("counts an actual HTTP upgrade as incoming activity", async () => {
  const server = createServer((_req, res) => res.end());
  const upgrade = (_req: unknown, socket: import("node:stream").Duplex) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
  };
  server.on("upgrade", upgrade);
  const capture = observeMaintenanceIncomingHttp(server);
  try {
    await withMaintenanceProvider(server, async origin => {
      const before = capture.snapshot();
      const client = request(origin, { signal: AbortSignal.timeout(5_000), headers: { Connection: "Upgrade", Upgrade: "fixture" } });
      try {
        await new Promise<void>((resolve, reject) => {
          client.once("error", reject);
          client.once("upgrade", (_response, socket) => { socket.destroy(); resolve(); });
          client.end();
        });
      } finally { client.destroy(); }
      expect(observeIncomingHttpWindow(before, capture.snapshot()).requests).toBe(1);
    });
  } finally { capture.dispose(); server.off("upgrade", upgrade); }
});

it("invalidates a detached listener and disposes only its own listeners", async () => {
  const app = (_req: unknown, res: import("node:http").ServerResponse) => res.end("app");
  const server = createServer(app);
  const unrelatedUpgrade = () => {};
  server.on("upgrade", unrelatedUpgrade);
  const originalRequest = server.listeners("request"), originalUpgrade = server.listeners("upgrade");
  const capture = observeMaintenanceIncomingHttp(server);
  try {
    await withMaintenanceProvider(server, async origin => {
      const counter = server.listeners("request")[0]! as (...args: unknown[]) => void;
      server.off("request", counter);
      expect(capture.snapshot()).toMatchObject({ installed: true, valid: false });
      // Reattaching cannot erase an unobserved interval.
      server.prependListener("request", counter);
      expect(capture.snapshot().valid).toBe(false);
      capture.dispose(); capture.dispose();
      expect(capture.snapshot()).toMatchObject({ installed: false, valid: false });
      expect(server.listeners("request")).toEqual(originalRequest);
      expect(server.listeners("upgrade")).toEqual(originalUpgrade);
      expect(await (await fetch(origin, { signal: AbortSignal.timeout(5_000) })).text()).toBe("app");
    });
  } finally { capture.dispose(); }
});

it("leaves Node's unsupported-upgrade behavior alone when the app has no upgrade handler", () => {
  const server = createServer((_req, res) => res.end());
  const requestHandlers = server.listeners("request"), upgradeHandlers = server.listeners("upgrade");
  expect(() => observeMaintenanceIncomingHttp(server)).toThrow("requires existing app request and upgrade handlers");
  expect(server.listeners("request")).toEqual(requestHandlers);
  expect(server.listeners("upgrade")).toEqual(upgradeHandlers);
});
