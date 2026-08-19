import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import {
  WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY,
  WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY,
  WORKSPACE_HANDOFF_KEY_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_HEADER,
  WORKSPACE_READINESS_USER_EMAIL_HEADER,
  WORKSPACE_READINESS_USER_ID_HEADER,
} from "../auth/workspace-login-handoff.js";

const tempDirs: string[] = [];
const envKeys = [
  "PAPERCLIP_CONFIG",
  WORKSPACE_HANDOFF_KEY_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_ENV_KEY,
  WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY,
  WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY,
] as const;
const previousEnv = new Map<string, string | undefined>();

function setEnv(values: Record<string, string>) {
  for (const key of envKeys) {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function createSeededWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-workspace-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "config.json"), "{}\n", "utf8");
  writeFileSync(
    path.join(dir, "seed-manifest.json"),
    JSON.stringify({ version: 2, state: "verified", phase: "complete", seedMode: "minimal" }),
    "utf8",
  );
  return path.join(dir, "config.json");
}

/**
 * Health's own queries (`instance_user_roles` / `invites` counts) and the
 * readiness probe's queries both come through `select`; a count projection
 * answers 1 and a row projection answers one row.
 */
function stubDb() {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn((projection?: Record<string, unknown>) => {
      const rows = projection && "count" in projection ? [{ count: 1 }] : [{ companyId: "company-1" }];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "limit", "orderBy"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    }),
  } as unknown as Db;
}

function createApp(actorType: "board" | "none") {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { actor: { type: string } }).actor = { type: actorType };
    next();
  });
  app.use(
    "/api/health",
    healthRoutes(stubDb(), {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }),
  );
  return app;
}

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/health workspace readiness", () => {
  it("exposes readiness to a board actor of a managed workspace", async () => {
    setEnv({
      PAPERCLIP_CONFIG: createSeededWorkspace(),
      [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "handoff-key",
      [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
      [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: "company-1",
    });
    const response = await request(createApp("board")).get("/api/health").expect(200);
    expect(response.body.workspace).toMatchObject({
      state: "ready",
      databaseReady: true,
      cloneDataReady: true,
      authHandoffReady: true,
      seedState: "verified",
      executionWorkspaceId: "ews-1",
      companyId: "company-1",
    });
  });

  it("keeps public health redacted for an anonymous caller", async () => {
    setEnv({
      PAPERCLIP_CONFIG: createSeededWorkspace(),
      [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "handoff-key",
      [WORKSPACE_READINESS_TOKEN_ENV_KEY]: "probe-token",
      [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
      [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: "company-1",
    });
    const response = await request(createApp("none")).get("/api/health").expect(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.workspace).toBeUndefined();
    expect(response.body.serverInfo).toBeUndefined();
  });

  it("accepts the derived probe token on an otherwise redacted response", async () => {
    setEnv({
      PAPERCLIP_CONFIG: createSeededWorkspace(),
      [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "handoff-key",
      [WORKSPACE_READINESS_TOKEN_ENV_KEY]: "probe-token",
      [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
      [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: "company-1",
    });
    const response = await request(createApp("none"))
      .get("/api/health")
      .set(WORKSPACE_READINESS_TOKEN_HEADER, "probe-token")
      .set(WORKSPACE_READINESS_USER_ID_HEADER, "user-1")
      .set(WORKSPACE_READINESS_USER_EMAIL_HEADER, "operator@example.com")
      .expect(200);
    expect(response.body.workspace).toMatchObject({
      state: "ready",
      instanceId: expect.any(String),
      authHandoffUserId: "user-1",
    });
    // Still redacted apart from readiness: the token buys one contract, not full detail.
    expect(response.body.serverInfo).toBeUndefined();
  });

  it("rejects a wrong probe token without leaking readiness", async () => {
    setEnv({
      PAPERCLIP_CONFIG: createSeededWorkspace(),
      [WORKSPACE_HANDOFF_KEY_ENV_KEY]: "handoff-key",
      [WORKSPACE_READINESS_TOKEN_ENV_KEY]: "probe-token",
      [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: "ews-1",
      [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: "company-1",
    });
    const response = await request(createApp("none"))
      .get("/api/health")
      .set(WORKSPACE_READINESS_TOKEN_HEADER, "probe-token-but-wrong")
      .expect(200);
    expect(response.body.workspace).toBeUndefined();
  });

  it("omits readiness entirely on an instance that is not a cloned workspace", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-primary-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "config.json"), "{}\n", "utf8");
    setEnv({ PAPERCLIP_CONFIG: path.join(dir, "config.json") });
    delete process.env[WORKSPACE_HANDOFF_KEY_ENV_KEY];
    delete process.env[WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY];
    const response = await request(createApp("board")).get("/api/health").expect(200);
    expect(response.body.workspace).toBeUndefined();
  });
});
