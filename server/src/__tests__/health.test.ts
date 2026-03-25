import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import { buildGitSha, serverVersion } from "../version.js";

describe("GET /health", () => {
  const app = express();
  app.use("/health", healthRoutes());

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: serverVersion,
      ...(buildGitSha ? { gitSha: buildGitSha } : {}),
    });
  });

  it("includes gitSha when running from a git repo", async () => {
    const res = await request(app).get("/health");
    expect(res.body.gitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
