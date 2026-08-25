import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const resolveHostFeatures = vi.hoisted(() => vi.fn());
vi.mock("../services/host-features.js", () => ({ resolveHostFeatures }));

import { runtimeFeatureRoutes } from "../routes/runtime-features.js";

function createApp(authenticated: boolean) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = authenticated
      ? {
        type: "board",
        userId: "board-user",
        userName: "Board User",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      }
      : { type: "none", source: "none" };
    next();
  });
  app.use("/api", runtimeFeatureRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("runtime feature revalidation route", () => {
  it("requires authentication and returns the current snapshot", async () => {
    resolveHostFeatures.mockResolvedValue({
      schemaVersion: 1,
      hostFeatures: ["apps.access_profiles"],
    });

    const unauthenticated = await request(createApp(false)).get("/api/runtime-features");
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request(createApp(true)).get("/api/runtime-features");
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toEqual({
      schemaVersion: 1,
      hostFeatures: ["apps.access_profiles"],
    });
  });
});
