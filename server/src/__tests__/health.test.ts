import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import { serverVersion } from "../version.js";

describe("GET /health", () => {
  const app = express();
  app.use("/health", healthRoutes());

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("includes configured auth providers when db-backed health options are supplied", async () => {
    const configuredApp = express();
    configuredApp.use(
      "/health",
      healthRoutes({} as never, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        authProviders: ["github", "google"],
      }),
    );

    const res = await request(configuredApp).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      authProviders: ["github", "google"],
      features: {
        companyDeletionEnabled: true,
      },
    });
  });
});
