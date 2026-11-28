import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { userRoutes } from "../routes/users.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("better-auth/crypto", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

import { hashPassword, verifyPassword } from "better-auth/crypto";

const mockVerifyPassword = vi.mocked(verifyPassword);
const mockHashPassword = vi.mocked(hashPassword);

function createDb(opts: {
  account?: { id: string; password: string } | null;
  sessions?: Array<{ id: string; userId: string; ipAddress: string | null; userAgent: string | null; createdAt: Date; updatedAt: Date }>;
} = {}) {
  const { account = null, sessions = [] } = opts;
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => ({
          then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
            cb(account ? [account] : []),
          ),
        })),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  };
}

function createSessionDb(sessions: Array<{ id: string; userId: string; ipAddress: string | null; userAgent: string | null; createdAt: Date; updatedAt: Date; expiresAt: Date }>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(sessions),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

function createApp(actor: unknown, db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/v1", userRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  sessionId: "session-current",
  companyIds: [],
  isInstanceAdmin: false,
};

describe("POST /v1/users/me/change-password", () => {
  it("returns 401 for a non-board actor", async () => {
    const app = createApp({ type: "agent", agentId: "a1", source: "agent_key" }, createDb());
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "old-pass", newPassword: "new-pass-long" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for local_implicit board (dev mode)", async () => {
    const app = createApp({ ...boardActor, source: "local_implicit" }, createDb());
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "old-pass", newPassword: "new-pass-long" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no credential account found", async () => {
    const app = createApp(boardActor, createDb({ account: null }));
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "old-pass", newPassword: "new-pass-long" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("No password-based account") });
  });

  it("returns 400 when currentPassword is wrong", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const app = createApp(boardActor, createDb({ account: { id: "acc-1", password: "hash" } }));
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "wrong-pass", newPassword: "new-pass-long" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Current password is incorrect") });
  });

  it("returns 400 when newPassword is under 8 characters", async () => {
    const app = createApp(boardActor, createDb({ account: { id: "acc-1", password: "hash" } }));
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "old-pass", newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("returns 200 and updates password on success", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    mockHashPassword.mockResolvedValue("new-hash");
    const app = createApp(boardActor, createDb({ account: { id: "acc-1", password: "hash" } }));
    const res = await request(app)
      .post("/v1/users/me/change-password")
      .send({ currentPassword: "correct-pass", newPassword: "new-pass-long" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Password changed" });
  });
});

describe("GET /v1/users/me/sessions", () => {
  it("returns 401 for non-board actor", async () => {
    const app = createApp({ type: "none", source: "none" }, createSessionDb([]));
    const res = await request(app).get("/v1/users/me/sessions");
    expect(res.status).toBe(401);
  });

  it("returns session list with isCurrent flag", async () => {
    const now = new Date();
    const sessions = [
      { id: "session-current", userId: "user-1", ipAddress: "1.2.3.4", userAgent: "Mozilla", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 86400000) },
      { id: "session-other", userId: "user-1", ipAddress: "5.6.7.8", userAgent: "curl", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 86400000) },
    ];
    const app = createApp(boardActor, createSessionDb(sessions));
    const res = await request(app).get("/v1/users/me/sessions");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const current = res.body.data.find((s: { id: string }) => s.id === "session-current");
    expect(current?.isCurrent).toBe(true);
    const other = res.body.data.find((s: { id: string }) => s.id === "session-other");
    expect(other?.isCurrent).toBe(false);
  });
});

describe("DELETE /v1/users/me/sessions/:id", () => {
  it("returns 401 for non-board actor", async () => {
    const app = createApp({ type: "none", source: "none" }, createSessionDb([]));
    const res = await request(app).delete("/v1/users/me/sessions/session-1");
    expect(res.status).toBe(401);
  });

  it("returns 404 when session does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => cb([])),
          }),
        }),
      }),
    };
    const app = createApp(boardActor, db);
    const res = await request(app).delete("/v1/users/me/sessions/no-such-id");
    expect(res.status).toBe(404);
  });

  it("returns 403 when session belongs to a different user", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
              cb([{ id: "session-1", userId: "other-user" }]),
            ),
          }),
        }),
      }),
    };
    const app = createApp(boardActor, db);
    const res = await request(app).delete("/v1/users/me/sessions/session-1");
    expect(res.status).toBe(403);
  });

  it("returns 204 when session belongs to current user", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
              cb([{ id: "session-1", userId: "user-1" }]),
            ),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    };
    const app = createApp(boardActor, db);
    const res = await request(app).delete("/v1/users/me/sessions/session-1");
    expect(res.status).toBe(204);
  });
});
