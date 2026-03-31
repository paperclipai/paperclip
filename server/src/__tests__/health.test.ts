import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

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
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("includes deploymentMode in response", async () => {
    const app = express();
    app.use("/health", healthRoutes(undefined, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      emailEnabled: false,
      socialProviders: ["google"],
      cloudSandboxEnabled: false,
      managedInferenceEnabled: false,
    }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      features: { socialProviders: ["google"] },
    });
  });
});
