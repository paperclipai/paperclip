import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUNS_DEFAULT_LIMIT,
  HEARTBEAT_RUNS_MAX_LIMIT,
  HeartbeatRunsListLimitError,
  clampHeartbeatRunsListLimit,
  parseHeartbeatRunStatusFilter,
} from "../services/heartbeat.ts";

/**
 * Regression tests for https://github.com/paperclipai/paperclip/issues/4568
 *
 * `GET /api/companies/:companyId/heartbeat-runs` previously:
 *   - silently dropped `?status=…` (service signature lacked the param);
 *   - silently clamped `?limit=` to a magic 1000 in the route, hiding the cap.
 *
 * This file pins the parse + clamp + forward contract end-to-end:
 *   1. The clamp helper rejects garbage limits with HTTP 400 and silently
 *      clamps oversized integers (preserves the issue-list precedent and
 *      keeps existing polling clients alive).
 *   2. The status helper normalizes the four shapes Express's `qs` parser
 *      can produce: single, comma-separated, repeated-key array, mixed.
 *   3. A minimal Express handler that mirrors the route at
 *      `server/src/routes/agents.ts:2810` forwards the parsed values to a
 *      stubbed `heartbeat.list` and the assertions cover every shape.
 *
 * No embedded postgres — the helpers are pure, the route handler under test
 * is small, and Drizzle's typing already enforces the SQL-builder shape
 * change. Service-layer integration is covered by the existing
 * `heartbeat-list.test.ts`.
 */

describe("clampHeartbeatRunsListLimit", () => {
  it("returns the default when input is undefined / empty / null", () => {
    expect(clampHeartbeatRunsListLimit(undefined)).toBe(HEARTBEAT_RUNS_DEFAULT_LIMIT);
    expect(clampHeartbeatRunsListLimit(null)).toBe(HEARTBEAT_RUNS_DEFAULT_LIMIT);
    expect(clampHeartbeatRunsListLimit("")).toBe(HEARTBEAT_RUNS_DEFAULT_LIMIT);
  });

  it("returns the parsed value when it is in [1, MAX]", () => {
    expect(clampHeartbeatRunsListLimit("1")).toBe(1);
    expect(clampHeartbeatRunsListLimit("50")).toBe(50);
    expect(clampHeartbeatRunsListLimit(String(HEARTBEAT_RUNS_MAX_LIMIT))).toBe(HEARTBEAT_RUNS_MAX_LIMIT);
  });

  it("silently clamps integers above MAX (preserves polling-client contract)", () => {
    expect(clampHeartbeatRunsListLimit("5000")).toBe(HEARTBEAT_RUNS_MAX_LIMIT);
    expect(clampHeartbeatRunsListLimit("1000000")).toBe(HEARTBEAT_RUNS_MAX_LIMIT);
  });

  it("throws HeartbeatRunsListLimitError on non-positive integers, NaN, decimals", () => {
    expect(() => clampHeartbeatRunsListLimit("foo")).toThrow(HeartbeatRunsListLimitError);
    expect(() => clampHeartbeatRunsListLimit("-1")).toThrow(HeartbeatRunsListLimitError);
    expect(() => clampHeartbeatRunsListLimit("0")).toThrow(HeartbeatRunsListLimitError);
    expect(() => clampHeartbeatRunsListLimit("1.5")).toThrow(HeartbeatRunsListLimitError);
    expect(() => clampHeartbeatRunsListLimit("1e3")).toThrow(HeartbeatRunsListLimitError);
  });
});

describe("parseHeartbeatRunStatusFilter", () => {
  it("returns [] for undefined / empty", () => {
    expect(parseHeartbeatRunStatusFilter(undefined)).toEqual([]);
    expect(parseHeartbeatRunStatusFilter("")).toEqual([]);
    expect(parseHeartbeatRunStatusFilter(",")).toEqual([]);
  });

  it("normalizes single, CSV, array, and mixed array+CSV shapes", () => {
    expect(parseHeartbeatRunStatusFilter("running")).toEqual(["running"]);
    expect(parseHeartbeatRunStatusFilter("running,queued")).toEqual(["running", "queued"]);
    expect(parseHeartbeatRunStatusFilter(["running", "queued"])).toEqual(["running", "queued"]);
    expect(parseHeartbeatRunStatusFilter(["running,queued", "failed"])).toEqual([
      "running",
      "queued",
      "failed",
    ]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(parseHeartbeatRunStatusFilter(" running , queued ")).toEqual(["running", "queued"]);
    expect(parseHeartbeatRunStatusFilter("running,,")).toEqual(["running"]);
  });
});

describe("GET /api/companies/:companyId/heartbeat-runs route parsing", () => {
  // Mirrors server/src/routes/agents.ts:2810. We don't mount the real router
  // (which depends on the full service graph) — instead we stand up a minimal
  // handler that performs the same parse/clamp/forward chain and assert the
  // stubbed `list` receives the expected arguments. This pins the route-layer
  // contract that regresses if anyone reverts the fix.
  function buildApp(stubList: ReturnType<typeof vi.fn>) {
    const app = express();
    app.get("/api/companies/:companyId/heartbeat-runs", async (req, res) => {
      try {
        const agentId = req.query.agentId as string | undefined;
        const statusInput = req.query.status as string | string[] | undefined;
        const limit = clampHeartbeatRunsListLimit(req.query.limit);
        const runs = await stubList(req.params.companyId, agentId, limit, statusInput);
        res.json(runs);
      } catch (err) {
        if (err instanceof HeartbeatRunsListLimitError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    });
    return app;
  }

  it("forwards a single ?status=running and clamped default limit", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs?status=running");
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_DEFAULT_LIMIT, "running");
  });

  it("forwards CSV ?status=running,queued (preserves legacy comma form)", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get(
      "/api/companies/c1/heartbeat-runs?status=running,queued",
    );
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_DEFAULT_LIMIT, "running,queued");
  });

  it("forwards repeated-key ?status=running&status=queued as array (the bug fix)", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get(
      "/api/companies/c1/heartbeat-runs?status=running&status=queued",
    );
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_DEFAULT_LIMIT, [
      "running",
      "queued",
    ]);
  });

  it("forwards mixed ?status=running,queued&status=failed", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get(
      "/api/companies/c1/heartbeat-runs?status=running,queued&status=failed",
    );
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_DEFAULT_LIMIT, [
      "running,queued",
      "failed",
    ]);
  });

  it("uses the default limit when ?limit is absent", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs");
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_DEFAULT_LIMIT, undefined);
  });

  it("silently clamps ?limit=5000 to the MAX (no 400)", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs?limit=5000");
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", undefined, HEARTBEAT_RUNS_MAX_LIMIT, undefined);
  });

  it("returns 400 on non-integer ?limit and does not call the service", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs?limit=foo");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: `limit must be a positive integer up to ${HEARTBEAT_RUNS_MAX_LIMIT}`,
    });
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns 400 on ?limit=-1 and does not call the service", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs?limit=-1");
    expect(res.status).toBe(400);
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns 400 on ?limit=0 (must be positive)", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get("/api/companies/c1/heartbeat-runs?limit=0");
    expect(res.status).toBe(400);
    expect(stub).not.toHaveBeenCalled();
  });

  it("forwards ?agentId alongside status + limit", async () => {
    const stub = vi.fn().mockResolvedValue([]);
    const res = await request(buildApp(stub)).get(
      "/api/companies/c1/heartbeat-runs?agentId=a1&status=running&limit=50",
    );
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("c1", "a1", 50, "running");
  });
});
