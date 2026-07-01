import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { adminQuietWindowRoutes } from "../routes/admin-quiet-window.js";

/**
 * Build a stub db whose `select().from().where()` resolves to `rows`.
 *
 * Drizzle's query builder is a thenable, so `await select(...).from(...).where(...)`
 * calls `.then` on the final node. The stub matches that shape.
 */
function stubDbWithRows(rows: unknown[]): Db {
  const thenable = {
    from() {
      return this;
    },
    where() {
      return Promise.resolve(rows);
    },
  };
  return {
    select: vi.fn(() => thenable),
  } as unknown as Db;
}

function stubDbThatThrows(error: Error): Db {
  const thenable = {
    from() {
      return this;
    },
    where() {
      return Promise.reject(error);
    },
  };
  return {
    select: vi.fn(() => thenable),
  } as unknown as Db;
}

function createApp(db?: Db) {
  const app = express();
  app.use("/admin/quiet-window", adminQuietWindowRoutes(db));
  return app;
}

describe("GET /admin/quiet-window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns safeToRestart=true when no runs are queued or running", async () => {
    const db = stubDbWithRows([{ checkedOutCount: 0, oldestStartedAt: null }]);
    const app = createApp(db);

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedOutCount: 0,
      oldestRunStartedAt: null,
      safeToRestart: true,
    });
  });

  it("returns safeToRestart=false with the oldest run timestamp when work is in flight", async () => {
    const oldest = new Date("2026-05-18T22:30:00.000Z");
    const db = stubDbWithRows([{ checkedOutCount: 3, oldestStartedAt: oldest }]);
    const app = createApp(db);

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedOutCount: 3,
      oldestRunStartedAt: oldest.toISOString(),
      safeToRestart: false,
    });
  });

  it("normalises a string oldestStartedAt into an ISO timestamp", async () => {
    // Some drivers return MIN(timestamp) as a string rather than a Date.
    const db = stubDbWithRows([
      { checkedOutCount: 1, oldestStartedAt: "2026-05-18T22:30:00.000Z" },
    ]);
    const app = createApp(db);

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(200);
    expect(res.body.oldestRunStartedAt).toBe("2026-05-18T22:30:00.000Z");
    expect(res.body.safeToRestart).toBe(false);
  });

  it("returns safe=true and skips the db when no db is wired", async () => {
    const app = createApp();

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedOutCount: 0,
      oldestRunStartedAt: null,
      safeToRestart: true,
    });
  });

  it("returns 503 with database_unreachable when the probe query throws", async () => {
    const db = stubDbThatThrows(new Error("connect ECONNREFUSED"));
    const app = createApp(db);

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "database_unreachable" });
  });

  it("rejects non-loopback callers with no admin actor", async () => {
    const db = stubDbWithRows([{ checkedOutCount: 0, oldestStartedAt: null }]);
    const app = express();
    app.use((req, _res, next) => {
      // Forge an off-host source to exercise the loopback gate.
      Object.defineProperty(req, "ip", { value: "10.0.0.5" });
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "10.0.0.5",
        configurable: true,
      });
      next();
    });
    app.use("/admin/quiet-window", adminQuietWindowRoutes(db));

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "loopback_only" });
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("allows an off-host caller that is an authenticated board admin", async () => {
    const db = stubDbWithRows([{ checkedOutCount: 0, oldestStartedAt: null }]);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: "10.0.0.5" });
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "10.0.0.5",
        configurable: true,
      });
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "session",
        userId: "user-1",
        userName: "Admin",
        userEmail: null,
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/admin/quiet-window", adminQuietWindowRoutes(db));

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(200);
    expect(res.body.safeToRestart).toBe(true);
  });

  it("rejects an off-host caller whose board grant came from local_trusted implicit-board", async () => {
    const db = stubDbWithRows([{ checkedOutCount: 0, oldestStartedAt: null }]);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: "10.0.0.5" });
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "10.0.0.5",
        configurable: true,
      });
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "local_implicit",
        userId: "local-board",
        userName: "Local Board",
        userEmail: null,
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/admin/quiet-window", adminQuietWindowRoutes(db));

    const res = await request(app).get("/admin/quiet-window");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "loopback_only" });
  });
});
