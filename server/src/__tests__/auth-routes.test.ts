import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { authRoutes } from "../routes/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain(row: unknown) {
  return {
    set(values: unknown) {
      return {
        where() {
          return {
            returning() {
              return Promise.resolve([{ ...(row as Record<string, unknown>), ...(values as Record<string, unknown>) }]);
            },
          };
        },
      };
    },
  };
}

function createInsertChain(inserts: Array<Record<string, unknown>>) {
  const chain = {
    values(values: Record<string, unknown>) {
      inserts.push(values);
      return chain;
    },
    onConflictDoNothing() {
      return Promise.resolve();
    },
    onConflictDoUpdate() {
      return Promise.resolve();
    },
  };
  return chain;
}

function createDb(row: Record<string, unknown>, opts: { companyRows?: Array<Record<string, unknown>> } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const select = vi
    .fn()
    .mockImplementationOnce(() => createSelectChain([row]))
    .mockImplementation(() => ({
      from() {
        return Promise.resolve(opts.companyRows ?? []);
      },
    }));
  return {
    select,
    update: () => createUpdateChain(row),
    insert: () => createInsertChain(inserts),
    inserts,
  } as any;
}

function createApp(actor: Express.Request["actor"], row: Record<string, unknown>, db = createDb(row)) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/auth", authRoutes(db));
  app.use(errorHandler);
  return app;
}

describe.sequential("auth routes", () => {
  const originalAdminEmails = process.env.PAPERCLIP_ADMIN_EMAILS;
  const originalDisableSignUp = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;

  afterEach(() => {
    if (originalAdminEmails === undefined) delete process.env.PAPERCLIP_ADMIN_EMAILS;
    else process.env.PAPERCLIP_ADMIN_EMAILS = originalAdminEmails;
    if (originalDisableSignUp === undefined) delete process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
    else process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = originalDisableSignUp;
  });

  const baseUser = {
    id: "user-1",
    name: "Jane Example",
    email: "jane@example.com",
    emailVerified: false,
    image: "https://example.com/jane.png",
  };

  it("returns the persisted user profile in the session payload", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session: {
        id: "paperclip:session:user-1",
        userId: "user-1",
      },
      user: {
        id: baseUser.id,
        name: baseUser.name,
        email: baseUser.email,
        image: baseUser.image,
      },
    });
  });


  it("grants configured admin users instance and company owner access on session load", async () => {
    process.env.PAPERCLIP_ADMIN_EMAILS = "alec@hltcorp.com";
    process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = "true";
    const adminUser = { ...baseUser, email: "ALEC@HLTCORP.COM", emailVerified: false };
    const db = createDb(adminUser, { companyRows: [{ id: "company-1" }, { id: "company-2" }] });
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      adminUser,
      db,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(db.inserts).toEqual([
      expect.objectContaining({ userId: "user-1", role: "instance_admin" }),
      expect.objectContaining({
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "owner",
      }),
      expect.objectContaining({
        companyId: "company-2",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "owner",
      }),
    ]);
  });


  it("does not grant configured admin access to unverified emails while sign-up is enabled", async () => {
    process.env.PAPERCLIP_ADMIN_EMAILS = "alec@hltcorp.com";
    delete process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
    const adminUser = { ...baseUser, email: "alec@hltcorp.com", emailVerified: false };
    const db = createDb(adminUser, { companyRows: [{ id: "company-1" }] });
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      adminUser,
      db,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(db.inserts).toEqual([]);
  });

  it("updates the signed-in profile", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator", image: "" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: null,
    });
  });

  it("preserves the existing avatar when updating only the profile name", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: "https://example.com/jane.png",
    });
  });

  it("accepts Paperclip asset paths for avatars", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "/api/assets/asset-1/content" });

    expect(res.status).toBe(200);
    expect(res.body.image).toBe("/api/assets/asset-1/content");
  });

  it("rejects invalid avatar image references", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "not-a-url" });

    expect(res.status).toBe(400);
  });
});
