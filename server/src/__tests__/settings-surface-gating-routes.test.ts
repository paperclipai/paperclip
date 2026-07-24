import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function boardActor(input: {
  userId: string;
  companyId: string;
  membershipRole: "owner" | "admin" | "operator" | "viewer";
  isInstanceAdmin?: boolean;
  source?: "session" | "local_implicit";
}) {
  return {
    type: "board",
    userId: input.userId,
    source: input.source ?? "session",
    isInstanceAdmin: input.isInstanceAdmin ?? false,
    companyIds: [input.companyId],
    memberships: [
      { companyId: input.companyId, membershipRole: input.membershipRole, status: "active" },
    ],
  };
}

async function createApp(db: Db, actor: Record<string, unknown>) {
  const { accessRoutes } = await import("../routes/access.js");
  const { secretRoutes } = await import("../routes/secrets.js");
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
  app.use("/api", secretRoutes(db));
  app.use(errorHandler);
  return app;
}

async function seedCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Surface Gating ${randomUUID()}`,
      issuePrefix: `SG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const ownerUserId = `owner-${randomUUID()}`;
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: ownerUserId,
    status: "active",
    membershipRole: "owner",
  });
  // The routes under test authorize via real permission grants
  // (`assertCompanyPermission` -> `access.canUser` -> explicit
  // `principalPermissionGrants` rows), unlike the local_implicit-bypass
  // harness in access-routes-permissions-upgrade.test.ts. Seed the same
  // default owner grants the real auth middleware lazily seeds on login so
  // the "session" actors here reach the surface gate instead of being
  // rejected earlier by the permission check.
  await ensureHumanRoleDefaultGrants(db, {
    companyId: company.id,
    principalId: ownerUserId,
    membershipRole: "owner",
    grantedByUserId: null,
  });
  return { company, ownerUserId };
}

describeEmbeddedPostgres("settings-surface gating on members/invites/secrets routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-surface-gating-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await instanceSettingsService(db).updateVisibility({
      companySurfaces: [
        "company.general",
        "company.members",
        "company.invites",
        "company.secrets",
        "company.plugins",
      ],
    });
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("default policy: owners reach members, invites, and secrets routes", async () => {
    const { company, ownerUserId } = await seedCompanyWithOwner(db);
    const app = await createApp(
      db,
      boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
    );
    await request(app).get(`/api/companies/${company.id}/members`).expect(200);
    await request(app).get(`/api/companies/${company.id}/invites`).expect(200);
    await request(app).get(`/api/companies/${company.id}/secrets`).expect(200);
  });

  it("hidden surfaces: owners get typed surface_not_exposed 403s per surface", async () => {
    const { company, ownerUserId } = await seedCompanyWithOwner(db);
    await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
    const app = await createApp(
      db,
      boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
    );

    for (const [path, surface] of [
      [`/api/companies/${company.id}/members`, "company.members"],
      [`/api/companies/${company.id}/join-requests`, "company.members"],
      [`/api/companies/${company.id}/invites`, "company.invites"],
      [`/api/companies/${company.id}/secrets`, "company.secrets"],
      [`/api/companies/${company.id}/secret-providers`, "company.secrets"],
    ] as const) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("surface_not_exposed");
      expect(res.body.details?.surface, path).toBe(surface);
    }

    const invite = await request(app)
      .post(`/api/companies/${company.id}/invites`)
      .send({ allowedJoinTypes: "human" });
    expect(invite.status).toBe(403);
    expect(invite.body.code).toBe("surface_not_exposed");
  });

  it("partial policy: exposing company.members only unlocks the members group", async () => {
    const { company, ownerUserId } = await seedCompanyWithOwner(db);
    await instanceSettingsService(db).updateVisibility({
      companySurfaces: ["company.members"],
    });
    const app = await createApp(
      db,
      boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
    );
    await request(app).get(`/api/companies/${company.id}/members`).expect(200);
    await request(app).get(`/api/companies/${company.id}/invites`).expect(403);
    await request(app).get(`/api/companies/${company.id}/secrets`).expect(403);
  });

  it("instance admins and the local_trusted implicit actor bypass hidden surfaces", async () => {
    const { company, ownerUserId } = await seedCompanyWithOwner(db);
    await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });

    const adminApp = await createApp(
      db,
      boardActor({
        userId: ownerUserId,
        companyId: company.id,
        membershipRole: "owner",
        isInstanceAdmin: true,
      }),
    );
    await request(adminApp).get(`/api/companies/${company.id}/members`).expect(200);
    await request(adminApp).get(`/api/companies/${company.id}/secrets`).expect(200);

    const localApp = await createApp(
      db,
      boardActor({
        userId: ownerUserId,
        companyId: company.id,
        membershipRole: "owner",
        isInstanceAdmin: true,
        source: "local_implicit",
      }),
    );
    await request(localApp).get(`/api/companies/${company.id}/invites`).expect(200);
  });

  it("viewer role matrix: permission denial still precedes the surface gate", async () => {
    const { company } = await seedCompanyWithOwner(db);
    const viewerId = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: viewerId,
      status: "active",
      membershipRole: "viewer",
    });
    await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
    const app = await createApp(
      db,
      boardActor({ userId: viewerId, companyId: company.id, membershipRole: "viewer" }),
    );
    const res = await request(app).get(`/api/companies/${company.id}/members`);
    expect(res.status).toBe(403);
    // Denied by users:manage_permissions BEFORE the surface gate runs; no
    // surface_not_exposed leak for actors who could not use the surface anyway.
    expect(res.body.code).not.toBe("surface_not_exposed");
  });

  it("user directory stays reachable when company.members is hidden (mentions dependency)", async () => {
    const { company, ownerUserId } = await seedCompanyWithOwner(db);
    await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
    const app = await createApp(
      db,
      boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
    );
    await request(app).get(`/api/companies/${company.id}/user-directory`).expect(200);
  });
});
