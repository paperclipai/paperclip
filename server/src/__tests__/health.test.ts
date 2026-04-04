import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

/** Build a chainable mock that resolves every select().from().where() chain. */
function mockDbWithProbe(
  probeResult: unknown = [{ "?column?": 1 }],
  probeError?: Error,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  for (const m of ["select", "from", "where"]) chain[m] = (..._a: unknown[]) => chain;
  chain.then = (fn: (v: unknown) => unknown) => Promise.resolve([{ count: 0 }]).then(fn);

  return {
    execute: probeError
      ? vi.fn().mockRejectedValue(probeError)
      : vi.fn().mockResolvedValue(probeResult),
    select: () => chain,
  } as unknown as Db;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok", async () => {
    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = mockDbWithProbe();
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      activeAgentCount: 0,
      activeRunCount: 0,
    });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = mockDbWithProbe(undefined, new Error("connect ECONNREFUSED"));
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
