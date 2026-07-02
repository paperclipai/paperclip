import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { BOARD_API_KEY_TTL_MS, boardAuthService } from "../services/board-auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

async function createApp(db: Db) {
  const { actorMiddleware } = await import("../middleware/auth.js");
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createBoardUser(db: Db) {
  const now = new Date();
  const userId = `refresh-user-${randomUUID()}`;
  await db.insert(authUsers).values({
    id: userId,
    name: "Refresh User",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const company = await db
    .insert(companies)
    .values({
      name: `Refresh Co ${randomUUID()}`,
      issuePrefix: `RF${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
  });
  return { userId, companyId: company.id };
}

describeEmbeddedPostgres("cli-auth refresh (sliding board key renewal)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cli-auth-refresh-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(boardApiKeys);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reports the key expiry on /cli-auth/me", async () => {
    const { userId } = await createBoardUser(db);
    const boardAuth = boardAuthService(db);
    const expiresAt = new Date(Date.now() + 5 * DAY_MS);
    const key = await boardAuth.createNamedBoardApiKey({
      userId,
      name: "me-expiry",
      expiresAt,
    });

    const res = await request(await createApp(db))
      .get("/api/cli-auth/me")
      .set("Authorization", `Bearer ${key.token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.keyId).toBe(key.id);
    expect(res.body.expiresAt).toBe(expiresAt.toISOString());
  }, 20_000);

  it("extends a soon-expiring key to a fresh TTL window and logs activity", async () => {
    const { userId, companyId } = await createBoardUser(db);
    const boardAuth = boardAuthService(db);
    const key = await boardAuth.createNamedBoardApiKey({
      userId,
      name: "near-expiry",
      expiresAt: new Date(Date.now() + 1 * DAY_MS),
    });

    const before = Date.now();
    const res = await request(await createApp(db))
      .post("/api/cli-auth/refresh")
      .set("Authorization", `Bearer ${key.token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.keyId).toBe(key.id);
    expect(res.body.refreshed).toBe(true);
    const newExpiry = new Date(res.body.expiresAt).getTime();
    expect(newExpiry).toBeGreaterThanOrEqual(before + BOARD_API_KEY_TTL_MS - 1000);

    const stored = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, key.id))
      .then((rows) => rows[0]!);
    expect(stored.expiresAt?.getTime()).toBe(newExpiry);

    const logged = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows.filter((row) => row.action === "board_api_key.refreshed"));
    expect(logged.length).toBe(1);
  }, 20_000);

  it("never shortens a key that already outlives a fresh TTL window", async () => {
    const { userId } = await createBoardUser(db);
    const boardAuth = boardAuthService(db);
    const farOut = new Date(Date.now() + 365 * DAY_MS);
    const key = await boardAuth.createNamedBoardApiKey({
      userId,
      name: "long-lived",
      expiresAt: farOut,
    });

    const res = await request(await createApp(db))
      .post("/api/cli-auth/refresh")
      .set("Authorization", `Bearer ${key.token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refreshed).toBe(false);
    expect(res.body.expiresAt).toBe(farOut.toISOString());
  }, 20_000);

  it("leaves a never-expires key untouched", async () => {
    const { userId } = await createBoardUser(db);
    const boardAuth = boardAuthService(db);
    const key = await boardAuth.createNamedBoardApiKey({
      userId,
      name: "never-expires",
      expiresAt: null,
    });

    const res = await request(await createApp(db))
      .post("/api/cli-auth/refresh")
      .set("Authorization", `Bearer ${key.token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refreshed).toBe(false);
    expect(res.body.expiresAt).toBeNull();

    const stored = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, key.id))
      .then((rows) => rows[0]!);
    expect(stored.expiresAt).toBeNull();
  }, 20_000);

  it("rejects refresh with an already-expired token", async () => {
    const { userId } = await createBoardUser(db);
    const boardAuth = boardAuthService(db);
    const key = await boardAuth.createNamedBoardApiKey({
      userId,
      name: "already-expired",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(await createApp(db))
      .post("/api/cli-auth/refresh")
      .set("Authorization", `Bearer ${key.token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(401);

    const stored = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, key.id))
      .then((rows) => rows[0]!);
    expect(stored.expiresAt!.getTime()).toBeLessThan(Date.now());
  }, 20_000);

  it("rejects refresh for board actors that are not backed by a board key", async () => {
    const { userId, companyId } = await createBoardUser(db);
    const { accessRoutes } = await import("../routes/access.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    });

    const res = await request(app).post("/api/cli-auth/refresh");
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  }, 20_000);
});
