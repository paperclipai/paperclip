import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authRoutes } from "../routes/auth.js";
import { errorHandler } from "../middleware/index.js";

const { logActivity, publishActivity } = vi.hoisted(() => ({ logActivity: vi.fn(), publishActivity: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity, publishActivity }));

const companyId = "11111111-1111-4111-8111-111111111111";
const actorExpectedId = "user-1";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const dialect = new PgDialect();

function setup(actor: Express.Request["actor"]) {
  const users = new Map([
    ["user-1", { keyboardShortcuts: false }],
    ["user-2", { keyboardShortcuts: false }],
    ["local-board", { keyboardShortcuts: false }],
  ]);
  const read = (where: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const query = dialect.sqlToQuery(where);
    expect(query.sql).toContain('"user"."id" =');
    const user = users.get(query.params[0] as string);
    return user ? [user] : [];
  };
  const update = vi.fn(() => ({
    set: (patch: { keyboardShortcuts: boolean }) => ({
      where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => ({
        returning: async () => {
          const rows = read(where);
          for (const row of rows) row.keyboardShortcuts = patch.keyboardShortcuts;
          return rows;
        },
      }),
    }),
  }));
  const db = {
    select: () => ({ from: () => ({ where: async (where: Parameters<typeof dialect.sqlToQuery>[0]) => read(where) }) }),
    update,
    transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const snapshot = structuredClone(users);
      try { return await fn(db); }
      catch (error) { users.clear(); for (const [key, value] of snapshot) users.set(key, value); throw error; }
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api/auth", authRoutes(db as never));
  app.use(errorHandler);
  return { app, users, update };
}

const board: Express.Request["actor"] = {
  type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [companyId],
};

describe("personal keyboard shortcut preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets a non-admin persist their preference without changing another user", async () => {
    const { app, users } = setup(board);
    expect((await request(app).get("/api/auth/preferences?expectedUserId=user-1")).body).toEqual({ keyboardShortcuts: false });
    const saved = await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: actorExpectedId, keyboardShortcuts: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ keyboardShortcuts: true });
    expect((await request(app).get("/api/auth/preferences?expectedUserId=user-1")).body).toEqual({ keyboardShortcuts: true });
    expect(users.get("user-2")).toEqual({ keyboardShortcuts: false });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId, actorId: "user-1", entityId: "user-1", action: "user.preferences_updated",
    }), expect.any(Array));
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: actorExpectedId, keyboardShortcuts: false })).body)
      .toEqual({ keyboardShortcuts: false });
  });

  it("allows viewer members to save their own preferences", async () => {
    const { app } = setup({ ...board, memberships: [{ companyId, membershipRole: "viewer", status: "active" }] } as Express.Request["actor"]);
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: "user-1", keyboardShortcuts: true })).status).toBe(200);
  });

  it("rejects reads and writes after the cookie changes accounts", async () => {
    const { app, update } = setup({ ...board, userId: "user-2" });
    expect((await request(app).get("/api/auth/preferences?expectedUserId=user-1")).status).toBe(401);
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: "user-1", keyboardShortcuts: true })).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("rolls back the preference when its audit record fails", async () => {
    const { app, users } = setup(board);
    logActivity.mockRejectedValueOnce(new Error("audit unavailable"));
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: "user-1", keyboardShortcuts: true })).status).toBe(500);
    expect(users.get("user-1")?.keyboardShortcuts).toBe(false);
  });

  it("reports a committed save as successful when activity publication fails", async () => {
    const { app, users } = setup(board);
    logActivity.mockImplementationOnce(async (_db, _input, publications) => {
      publications.push({ companyId, payload: {} });
    });
    publishActivity.mockImplementationOnce(() => { throw new Error("subscriber unavailable"); });
    const saved = await request(app).patch("/api/auth/preferences")
      .send({ companyId, expectedUserId: "user-1", keyboardShortcuts: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ keyboardShortcuts: true });
    expect(users.get("user-1")?.keyboardShortcuts).toBe(true);
    expect(publishActivity).toHaveBeenCalledOnce();
  });

  it("supports the local trusted board identity", async () => {
    const { app } = setup({ type: "board", userId: "local-board", source: "local_implicit" });
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: "local-board", keyboardShortcuts: true })).status).toBe(200);
  });

  it.each([
    { type: "none" },
    { type: "agent", agentId: "agent-1", companyId },
    { type: "board", source: "session" },
  ] as Express.Request["actor"][])("rejects requests without a board user: %j", async (actor) => {
    const { app, update } = setup(actor);
    expect((await request(app).get("/api/auth/preferences?expectedUserId=user-1")).status).toBe(401);
    expect((await request(app).patch("/api/auth/preferences").send({ companyId, expectedUserId: actorExpectedId, keyboardShortcuts: true })).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an inaccessible company audit context", async () => {
    const { app, update } = setup(board);
    expect((await request(app).patch("/api/auth/preferences").send({ companyId: otherCompanyId, expectedUserId: actorExpectedId, keyboardShortcuts: true })).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it.each([
    { keyboardShortcuts: true },
    { companyId, keyboardShortcuts: "true" },
    { companyId, keyboardShortcuts: true, userId: "user-2" },
  ])("rejects invalid or caller-selected identities: %j", async (body) => {
    const { app, update } = setup(board);
    expect((await request(app).patch("/api/auth/preferences").send(body)).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
