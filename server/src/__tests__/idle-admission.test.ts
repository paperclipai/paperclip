import express from "express";
import request from "supertest";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain, readTaskDrain, beginIdleTrackedWork } from "../services/task-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function app() { const app = express(); app.use(idleAdmissionMiddleware); return app; }
afterEach(() => stopTaskDrain());

describe("idle admission", () => {
  it("preserves legacy drains, but blocks all new work during an owned idle hold", async () => {
    const server = app();
    server.all("/{*path}", (_req, res) => res.sendStatus(204));
    trackIdleRequestHandlers(server);
    startTaskDrain({ ttlMs: 60_000 });
    await request(server).post("/api/issues").expect(204);
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    for (const path of ["/api/issues", "/api/chat-webhooks/test", "/mcp", "/api/auth/callback"]) {
      await request(server).get(path).expect(503).expect("Retry-After", "1");
      await request(server).post(path).expect(503);
    }
    await request(server).get("/api/health").expect(204);
    await request(server).get("/api/instance/task-drain/").expect(204);
    await request(server).post("/api/instance/task-drain").expect(204);
    stopTaskDrain();
    await request(server).post("/api/issues").expect(204);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("counts a nested async handler after it sends a response", async () => {
    const server = app();
    const router = express.Router();
    const done = deferred();
    router.post("/work", async (_req, res) => { res.sendStatus(202); await done.promise; });
    server.use("/api", router);
    trackIdleRequestHandlers(server);
    await request(server).post("/api/work").expect(202);
    expect(idleWorkSnapshot().active).toBe(1);
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    await request(server).post("/api/work").expect(503);
    done.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("does not mistake a client disconnect for completed accepted work", async () => {
    const server = app();
    const entered = deferred(), done = deferred(), closed = deferred();
    server.post("/work", async (_req, res) => { res.once("close", closed.resolve); entered.resolve(); await done.promise; /* client has left */ });
    trackIdleRequestHandlers(server);
    const listener = server.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const address = listener.address() as { port: number };
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/work", method: "POST" });
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await closed.promise;
      startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
      expect(idleWorkSnapshot().active).toBe(1);
      done.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(idleWorkSnapshot().active).toBe(0);
    } finally {
      done.resolve(); client.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });

  it("settles errors through async Express error middleware", async () => {
    const server = app(), done = deferred();
    server.get("/work", async () => { throw new Error("test"); });
    server.use(async (_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.sendStatus(500); await done.promise;
    });
    trackIdleRequestHandlers(server);
    await request(server).get("/work").expect(500);
    expect(idleWorkSnapshot().active).toBe(1);
    done.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("uses unique owners even for simultaneous starts and expires the hold", () => {
    const first = startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    const second = startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    expect(second.ownerId).not.toBe(first.ownerId);
    expect(readTaskDrain(second.expiresAt!)).toBeNull();
  });

  it("records even work that starts and finishes between observations", () => {
    const before = idleWorkSnapshot();
    const done = beginIdleTrackedWork(); done(); done();
    expect(idleWorkSnapshot()).toEqual({ active: before.active, generation: before.generation + 2 });
  });
});
