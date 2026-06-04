import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localInferenceRoutes } from "../routes/local-inference.js";

const localHealthMock = vi.hoisted(() => vi.fn(async () => ({
  available: true,
  url: "http://localhost:1234/v1",
  models: ["qwen/qwen3-coder-30b"],
})));

vi.mock("@paperclipai/adapter-local/server", () => ({
  getLocalInferenceHealth: localHealthMock,
}));

function createApp() {
  const app = express();
  app.use("/api", localInferenceRoutes());
  return app;
}

describe("GET /api/inference/local/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns local inference health", async () => {
    const res = await request(createApp()).get("/api/inference/local/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      url: "http://localhost:1234/v1",
      models: ["qwen/qwen3-coder-30b"],
    });
  });

  it("ignores client-supplied baseUrl and passes timeout only", async () => {
    await request(createApp())
      .get("/api/inference/local/health")
      .query({ baseUrl: "http://evil.test/v1", timeoutSec: "4" });

    expect(localHealthMock).toHaveBeenCalledWith({
      timeoutSec: 4,
    });
  });
});
