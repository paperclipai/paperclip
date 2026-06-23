import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { deriveRuntimeControls } from "../runtime-roles.js";
import { shouldLoadPluginsForRuntime, stagedRuntimeMutationGuard, startPluginSchedulersForRuntime } from "../app.js";

describe("runtime role app gates", () => {
  it("starts plugin scheduler systems in primary", () => {
    const controls = deriveRuntimeControls({
      role: "primary",
      databaseBackupEnabled: false,
      feedbackExporterConfigured: false,
    });
    const jobCoordinator = { start: vi.fn() };
    const scheduler = { start: vi.fn() };

    expect(startPluginSchedulersForRuntime(controls, jobCoordinator, scheduler)).toBe(true);
    expect(jobCoordinator.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(shouldLoadPluginsForRuntime(controls)).toBe(true);
  });

  it("does not start plugin scheduler systems or load workers in staged", () => {
    const controls = deriveRuntimeControls({
      role: "staged",
      databaseBackupEnabled: false,
      feedbackExporterConfigured: false,
    });
    const jobCoordinator = { start: vi.fn() };
    const scheduler = { start: vi.fn() };

    expect(startPluginSchedulersForRuntime(controls, jobCoordinator, scheduler)).toBe(false);
    expect(jobCoordinator.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(shouldLoadPluginsForRuntime(controls)).toBe(false);
  });

  it("does not start plugin scheduler systems or load workers in api-only", () => {
    const controls = deriveRuntimeControls({
      role: "api-only",
      databaseBackupEnabled: false,
      feedbackExporterConfigured: false,
    });
    const jobCoordinator = { start: vi.fn() };
    const scheduler = { start: vi.fn() };

    expect(startPluginSchedulersForRuntime(controls, jobCoordinator, scheduler)).toBe(false);
    expect(jobCoordinator.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(shouldLoadPluginsForRuntime(controls)).toBe(false);
  });

  it("blocks non-safe API methods in staged", async () => {
    const controls = deriveRuntimeControls({
      role: "staged",
      databaseBackupEnabled: false,
      feedbackExporterConfigured: false,
    });
    const app = express();
    app.use(stagedRuntimeMutationGuard(controls));
    app.get("/probe", (_req, res) => res.json({ ok: true }));
    app.post("/probe", (_req, res) => res.json({ ok: true }));

    await expect(request(app).get("/probe")).resolves.toMatchObject({ status: 200 });
    const post = await request(app).post("/probe").send({});
    expect(post.status).toBe(403);
    expect(post.body).toEqual({ error: "runtime_role_staged_read_only" });
  });
});
