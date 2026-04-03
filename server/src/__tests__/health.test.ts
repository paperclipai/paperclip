import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { buildGitSha, serverVersion } from "../version.js";

describe("GET /health", () => {
  function buildApp(db?: Db) {
    const app = express();
    app.use("/health", healthRoutes(db));
    return app;
  }

  beforeEach(() => {
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok", async () => {
    const res = await request(buildApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: serverVersion,
      ...(buildGitSha ? { gitSha: buildGitSha } : {}),
    });
  });

  it("includes gitSha when running from a git repo", async () => {
    const res = await request(buildApp()).get("/health");
    if (buildGitSha) {
      expect(res.body.gitSha).toMatch(/^[0-9a-f]{40}$/);
    } else {
      expect(res.body.gitSha).toBeUndefined();
    }
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const res = await request(buildApp(db)).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const res = await request(buildApp(db)).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
