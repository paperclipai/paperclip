import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, instanceUserRoles, authUsers } from "@paperclipai/db";
import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Record<string, unknown>) {
  const { accessRoutes } = await import("../routes/access.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /cli-auth/me capabilities", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cli-auth-me-capabilities-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  const memberActor = {
    type: "board",
    userId: "user-member",
    source: "session",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
  };

  it("returns all surfaces + derived features + empty standings under the default policy", async () => {
    // Migration 0105 seeds a "Local" default environment and points
    // instance_settings.default_environment_id at it on every fresh DB, so
    // the baseline value here is that seeded id, not null. Read it back
    // instead of hardcoding, since the id is random per test-db instance.
    const seededSettings = await instanceSettingsService(db).get();

    const app = await createApp(db, memberActor);
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(200);
    expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
    expect(res.body.capabilities.companyStandings).toEqual({});
    expect(res.body.capabilities.features).toMatchObject({
      enableEnvironments: false,
      enableCloudSync: false,
      keyboardShortcuts: false,
      executionMode: "any",
      defaultEnvironmentId: seededSettings.defaultEnvironmentId,
    });
    expect(res.body.capabilities.features).not.toHaveProperty("enableWorktreeRunExecution");
  });

  it("reflects the visibility policy for non-admin members and flag toggles in features", async () => {
    const svc = instanceSettingsService(db);
    await svc.updateVisibility({ companySurfaces: ["company.general", "company.members"] });
    await svc.updateExperimental({ enableCloudSync: true });

    const app = await createApp(db, memberActor);
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(200);
    expect(res.body.capabilities.exposedSurfaces).toEqual(["company.general", "company.members"]);
    expect(res.body.capabilities.features.enableCloudSync).toBe(true);
    expect(res.body.isInstanceAdmin).toBe(false);
  });

  it("gives actor-claimed instance admins the full surface list despite a restrictive policy", async () => {
    const app = await createApp(db, { ...memberActor, userId: "user-admin", isInstanceAdmin: true });
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(200);
    expect(res.body.isInstanceAdmin).toBe(true);
    expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
  });

  it("gives DB-role instance admins the full surface list", async () => {
    await db
      .insert(authUsers)
      .values({
        id: "db-admin",
        name: "DB Admin",
        email: "dbadmin@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(instanceUserRoles).values({ userId: "db-admin", role: "instance_admin" }).onConflictDoNothing();
    const app = await createApp(db, {
      type: "board",
      userId: "db-admin",
      source: "session",
      isInstanceAdmin: false, // stale claim; DB role must win
      companyIds: [],
      memberships: [],
    });
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(200);
    expect(res.body.isInstanceAdmin).toBe(true);
    expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
    await db.delete(instanceUserRoles).where(and(eq(instanceUserRoles.userId, "db-admin"), eq(instanceUserRoles.role, "instance_admin")));
  });

  it("local_trusted regression: the implicit actor is an instance admin with every surface", async () => {
    const app = await createApp(db, {
      type: "board",
      userId: "local-board",
      userName: "Local Board",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    });
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(200);
    expect(res.body.isInstanceAdmin).toBe(true);
    expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
  });
});
