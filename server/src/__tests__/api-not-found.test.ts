import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("unmatched API routes", () => {
  it("returns JSON 404 instead of falling through to UI middleware", async () => {
    const app = await createApp({} as any, {
      uiMode: "vite-dev",
      storageService: {} as any,
      deploymentMode: "local_trusted",
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const res = await request(app).get("/api/issues?assigneeId=test&status=todo");

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ error: "Not found", path: "/api/issues" });
  });
});
