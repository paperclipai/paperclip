/**
 * MAT-685 — F10 / F11 / F12 security gate tests
 *
 * F10: role-rank escalation prevention on PATCH /members/:id and /members/:id/role-and-grants
 * F11: permission-grant containment on PATCH /members/:id/permissions and /members/:id/role-and-grants
 * F12: invite humanRole gate on POST /companies/:id/invites
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── service mocks ──────────────────────────────────────────────────────────
const accessMock = {
  isInstanceAdmin: vi.fn().mockResolvedValue(false),
  canUser: vi.fn().mockResolvedValue(true),
  hasPermission: vi.fn().mockResolvedValue(true),
  getMemberById: vi.fn(),
  getMembership: vi.fn(),
  setMemberPermissions: vi.fn(),
};

vi.mock("../services/index.js", () => ({
  accessService: () => accessMock,
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

// ── db stub helpers ────────────────────────────────────────────────────────
function makeMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    companyId: "co-1",
    principalType: "user",
    principalId: "user-target",
    membershipRole: "viewer",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Creates a chainable query stub that resolves with `rows`. */
function makeSelectQuery(rows: unknown[]): any {
  const p = Promise.resolve(rows);
  const q: any = Object.assign(p, {
    from() { return q; },
    leftJoin() { return q; },
    where() { return q; },
    orderBy() { return q; },
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  });
  return q;
}

/** db stub whose transaction always calls the callback with the same select stub */
function createDbStub(existingMembership: Record<string, unknown> | null = makeMembership()) {
  const memberRows = existingMembership ? [existingMembership] : [];
  const emptyRows: unknown[] = [];

  function makeDb(rows: unknown[] = memberRows): any {
    return {
      execute: vi.fn().mockResolvedValue(undefined),
      select(_shape?: unknown) { return makeSelectQuery(rows); },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([existingMembership]);
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values() {
            return Promise.resolve();
          },
        };
      },
      delete() {
        return { where() { return Promise.resolve(); } };
      },
      transaction(fn: (tx: unknown) => unknown) {
        return fn(makeDb(memberRows));
      },
    };
  }

  // outer db: select on companyMemberships returns member rows,
  // but select on other tables (principalPermissionGrants, authUsers) returns empty
  const db: any = {
    execute: vi.fn().mockResolvedValue(undefined),
    select(_shape?: unknown) { return makeSelectQuery(memberRows); },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([existingMembership]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values() {
          return Promise.resolve();
        },
      };
    },
    delete() {
      return { where() { return Promise.resolve(); } };
    },
    transaction(fn: (tx: unknown) => unknown) {
      const tx: any = {
        execute: vi.fn().mockResolvedValue(undefined),
        select(_shape?: unknown) { return makeSelectQuery(memberRows); },
        update() {
          return {
            set() {
              return {
                where() {
                  return {
                    returning() {
                      return Promise.resolve([existingMembership]);
                    },
                  };
                },
              };
            },
          };
        },
        insert() {
          return { values() { return Promise.resolve(); } };
        },
        delete() {
          return { where() { return Promise.resolve(); } };
        },
      };
      return fn(tx);
    },
  };

  // loadCompanyMemberRecords calls select twice (members + grants) and loadUsersById once.
  // We want members query to return memberRows, grants/users to return [].
  // Use a counter: first call → memberRows, subsequent → [].
  let selectCallCount = 0;
  db.select = function (_shape?: unknown) {
    selectCallCount += 1;
    return makeSelectQuery(selectCallCount === 1 ? memberRows : emptyRows);
  };

  return db;
}

// ── app factory ────────────────────────────────────────────────────────────
interface ActorOverride {
  membershipRole?: string;
  isInstanceAdmin?: boolean;
  source?: string;
}

async function createApp(
  db: ReturnType<typeof createDbStub>,
  actorOverride: ActorOverride = {},
) {
  const { accessRoutes } = await import("../routes/access.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());

  const source = actorOverride.source ?? "board_api_key";
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source,
      userId: "user-actor",
      companyIds: ["co-1"],
      isInstanceAdmin: actorOverride.isInstanceAdmin ?? false,
    };
    next();
  });

  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "cloud",
      deploymentExposure: "public",
      bindHost: "0.0.0.0",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

// ── shared setup ───────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  accessMock.isInstanceAdmin.mockResolvedValue(false);
  accessMock.canUser.mockResolvedValue(true);
  accessMock.hasPermission.mockResolvedValue(true);
});

// ══════════════════════════════════════════════════════════════════════════
// F10 — role-rank escalation
// ══════════════════════════════════════════════════════════════════════════
describe("F10 — role-rank escalation guard", () => {
  /** actor is 'admin' (rank 3); tries to assign 'owner' (rank 4) */
  function setupAdminActor() {
    // getMembership called by resolveActorHumanRole returns actor's membership
    accessMock.getMembership.mockImplementation(
      (_cid: string, _pt: string, principalId: string) => {
        if (principalId === "user-actor") {
          return Promise.resolve({
            membershipRole: "admin",
            status: "active",
          });
        }
        return Promise.resolve(null);
      },
    );
    accessMock.getMemberById.mockResolvedValue(
      makeMembership({ membershipRole: "viewer", principalId: "user-target" }),
    );
  }

  it("PATCH /members/:id — 403 when assigning role >= actor role", async () => {
    setupAdminActor();
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1")
      .send({ membershipRole: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role equal to or higher/i);
  });

  it("PATCH /members/:id — 200 when assigning role < actor role", async () => {
    setupAdminActor();
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1")
      .send({ membershipRole: "operator" });

    expect(res.status).toBe(200);
  });

  it("PATCH /members/:id — 200 when no membershipRole change", async () => {
    setupAdminActor();
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1")
      .send({ status: "active" });

    expect(res.status).toBe(200);
  });

  it("PATCH /members/:id/role-and-grants — 403 when assigning role >= actor role", async () => {
    setupAdminActor();
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/role-and-grants")
      .send({ membershipRole: "owner", grants: [] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role equal to or higher/i);
  });

  it("PATCH /members/:id/role-and-grants — 200 when assigning role < actor role", async () => {
    setupAdminActor();
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/role-and-grants")
      .send({ membershipRole: "operator", grants: [] });

    expect(res.status).toBe(200);
  });

  it("instance admin bypasses F10 restriction", async () => {
    accessMock.getMembership.mockResolvedValue({ membershipRole: "admin", status: "active" });
    accessMock.getMemberById.mockResolvedValue(makeMembership({ membershipRole: "viewer" }));
    const db = createDbStub();
    const app = await createApp(db, { isInstanceAdmin: true });

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1")
      .send({ membershipRole: "owner" });

    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F11 — permission-grant containment
// ══════════════════════════════════════════════════════════════════════════
describe("F11 — permission-grant containment", () => {
  beforeEach(() => {
    accessMock.getMembership.mockImplementation(
      (_cid: string, _pt: string, principalId: string) => {
        if (principalId === "user-actor") {
          return Promise.resolve({ membershipRole: "admin", status: "active" });
        }
        return Promise.resolve(null);
      },
    );
    accessMock.getMemberById.mockResolvedValue(makeMembership());
  });

  it("PATCH /permissions — 403 when actor lacks a grant key", async () => {
    // canUser returns true for users:manage_permissions (assertCompanyPermission) but
    // false for any other key (assertActorOwnsAllGrantKeys)
    accessMock.canUser.mockImplementation((_cid: string, _uid: string, key: string) =>
      Promise.resolve(key === "users:manage_permissions"),
    );
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/permissions")
      .send({ grants: [{ permissionKey: "users:invite" }] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not hold permission/i);
  });

  it("PATCH /permissions — 200 when actor holds all grant keys", async () => {
    accessMock.canUser.mockResolvedValue(true);
    accessMock.setMemberPermissions.mockResolvedValue(makeMembership());
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/permissions")
      .send({ grants: [{ permissionKey: "users:invite" }] });

    expect(res.status).toBe(200);
  });

  it("PATCH /role-and-grants — 403 when actor lacks a grant key", async () => {
    accessMock.canUser.mockImplementation((_cid: string, _uid: string, key: string) =>
      Promise.resolve(key === "users:manage_permissions"),
    );
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/role-and-grants")
      .send({ membershipRole: "operator", grants: [{ permissionKey: "users:invite" }] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not hold permission/i);
  });

  it("PATCH /role-and-grants — 200 with empty grants skips grant-key check", async () => {
    // canUser returns true only for manage_permissions; no grant keys are checked so no 403
    accessMock.canUser.mockImplementation((_cid: string, _uid: string, key: string) =>
      Promise.resolve(key === "users:manage_permissions"),
    );
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/role-and-grants")
      .send({ membershipRole: "operator", grants: [] });

    expect(res.status).toBe(200);
  });

  it("instance admin bypasses F11 grant-key restriction", async () => {
    // For instance admins, real canUser returns true (it checks isInstanceAdmin first).
    // We mirror that: canUser returns true so assertCompanyPermission passes,
    // and req.actor.isInstanceAdmin=true means assertActorOwnsAllGrantKeys is skipped.
    accessMock.canUser.mockResolvedValue(true);
    accessMock.setMemberPermissions.mockResolvedValue(makeMembership());
    const db = createDbStub();
    const app = await createApp(db, { isInstanceAdmin: true });

    const res = await request(app)
      .patch("/api/companies/co-1/members/mem-1/permissions")
      .send({ grants: [{ permissionKey: "users:manage_permissions" }] });

    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F12 — invite humanRole gate
// ══════════════════════════════════════════════════════════════════════════
describe("F12 — invite humanRole gate", () => {
  function setupInviteDb() {
    const createdInvite = {
      id: "invite-1",
      companyId: "co-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: { humanRole: "operator" },
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return {
      insert() {
        return {
          values() {
            return { returning() { return Promise.resolve([createdInvite]); } };
          },
        };
      },
      select(_shape?: unknown) {
        const q: any = {
          from() { return q; },
          leftJoin() { return q; },
          where() { return Promise.resolve([{ name: "Acme", brandColor: null, logoAssetId: null }]); },
        };
        return q;
      },
    };
  }

  beforeEach(() => {
    accessMock.canUser.mockResolvedValue(true);
    accessMock.getMembership.mockImplementation(
      (_cid: string, _pt: string, principalId: string) => {
        if (principalId === "user-actor") {
          return Promise.resolve({ membershipRole: "operator", status: "active" });
        }
        return Promise.resolve(null);
      },
    );
  });

  it("403 when operator tries to invite with humanRole=admin", async () => {
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "admin" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role equal to or higher/i);
  });

  it("403 when operator tries to invite with humanRole=owner", async () => {
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(403);
  });

  it("201 when operator invites with humanRole=viewer", async () => {
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(201);
  });

  it("201 when humanRole is omitted (no rank check needed)", async () => {
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human" });

    expect(res.status).toBe(201);
  });

  it("admin can invite with humanRole=admin (equal rank blocked)", async () => {
    accessMock.getMembership.mockImplementation(
      (_cid: string, _pt: string, principalId: string) => {
        if (principalId === "user-actor") {
          return Promise.resolve({ membershipRole: "admin", status: "active" });
        }
        return Promise.resolve(null);
      },
    );
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human", humanRole: "admin" });

    // admin rank 3, inviting admin rank 3 → equal → 403
    expect(res.status).toBe(403);
  });

  it("owner can invite with humanRole=admin", async () => {
    accessMock.getMembership.mockImplementation(
      (_cid: string, _pt: string, principalId: string) => {
        if (principalId === "user-actor") {
          return Promise.resolve({ membershipRole: "owner", status: "active" });
        }
        return Promise.resolve(null);
      },
    );
    const app = await createApp(setupInviteDb() as any);

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human", humanRole: "admin" });

    expect(res.status).toBe(201);
  });

  it("instance admin bypasses F12 humanRole gate", async () => {
    const app = await createApp(setupInviteDb() as any, { isInstanceAdmin: true });

    const res = await request(app)
      .post("/api/companies/co-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(201);
  });
});
