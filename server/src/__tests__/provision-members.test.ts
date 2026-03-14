import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stable mock instances — same objects returned by every factory call
const companySvcMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
const agentSvcMock = {
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
};
const accessSvcMock = {
  ensureMembership: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  setPrincipalGrants: vi.fn(),
  removeMembership: vi.fn(),
  listUserCompanyAccess: vi.fn(),
};
const logActivityMock = vi.fn();

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@paperclipai/db", () => ({
  authUsers: { id: "id" },
  authAccounts: {
    id: "id",
    userId: "userId",
    accountId: "accountId",
    providerId: "providerId",
    password: "password",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/index.js", () => ({
  companyService: () => companySvcMock,
  agentService: () => agentSvcMock,
  accessService: () => accessSvcMock,
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));

import { provisionRoutes } from "../routes/provision.js";

const SECRET = "test-provision-secret-123";

/** Build a mock db that supports the chained select/insert calls. */
function createMockDb() {
  const thenFn = vi.fn().mockResolvedValue(null);
  const whereFn = vi.fn().mockReturnValue({ then: thenFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const valuesFn = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  return {
    select: selectFn,
    insert: insertFn,
    _thenFn: thenFn,
    _whereFn: whereFn,
    _fromFn: fromFn,
    _valuesFn: valuesFn,
  };
}

function createApp(mockDb: ReturnType<typeof createMockDb>) {
  vi.stubEnv("WOPR_PROVISION_SECRET", SECRET);
  const app = express();
  app.use(express.json());
  app.use("/internal", provisionRoutes(mockDb as any));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

describe("provision member routes", () => {
  let app: express.Express;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockDb = createMockDb();
    app = createApp(mockDb);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe("POST /internal/members/add", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app)
        .post("/internal/members/add")
        .send({ companyId: "c1", user: { id: "u1", email: "a@b.com" }, role: "member" });
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await request(app)
        .post("/internal/members/add")
        .set("Authorization", "Bearer wrong-token")
        .send({ companyId: "c1", user: { id: "u1", email: "a@b.com" }, role: "member" });
      expect(res.status).toBe(401);
    });

    it("calls ensureUser + ensureMembership + setPrincipalGrants for member role", async () => {
      // ensureUser — db.select().from().where().then() returns null (no existing user)
      mockDb._thenFn.mockResolvedValue(null);
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" });
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/add")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({
          companyId: "comp-1",
          user: { id: "user-1", email: "member@acme.com", name: "Member" },
          role: "member",
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // ensureUser is called (db.insert for auth user)
      expect(mockDb.insert).toHaveBeenCalled();

      // ensureMembership with member role
      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "member",
        "active",
      );

      // setPrincipalGrants with member permissions (just tasks:assign)
      expect(accessSvcMock.setPrincipalGrants).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        [{ permissionKey: "tasks:assign" }],
        null,
      );

      // Should NOT promote to instance admin
      expect(accessSvcMock.promoteInstanceAdmin).not.toHaveBeenCalled();
    });

    it("promotes to instance admin for owner role", async () => {
      mockDb._thenFn.mockResolvedValue({ id: "user-1" }); // user exists
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" });
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/add")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({
          companyId: "comp-1",
          user: { id: "user-1", email: "owner@acme.com", name: "Owner" },
          role: "owner",
        });

      expect(res.status).toBe(200);
      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "owner",
        "active",
      );
      expect(accessSvcMock.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    });

    it("promotes to instance admin for admin role", async () => {
      mockDb._thenFn.mockResolvedValue({ id: "user-1" });
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" });
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/add")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({
          companyId: "comp-1",
          user: { id: "user-1", email: "admin@acme.com", name: "Admin" },
          role: "admin",
        });

      expect(res.status).toBe(200);
      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "owner",
        "active",
      );
      expect(accessSvcMock.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    });

    it("is idempotent — does not throw if member already exists", async () => {
      mockDb._thenFn.mockResolvedValue({ id: "user-1" }); // user exists
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" }); // idempotent upsert
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/add")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({
          companyId: "comp-1",
          user: { id: "user-1", email: "member@acme.com", name: "Member" },
          role: "member",
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("POST /internal/members/remove", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app)
        .post("/internal/members/remove")
        .send({ companyId: "c1", userId: "u1" });
      expect(res.status).toBe(401);
    });

    it("calls removeMembership and demotes if no remaining companies", async () => {
      accessSvcMock.removeMembership.mockResolvedValue(undefined);
      accessSvcMock.listUserCompanyAccess.mockResolvedValue([]); // no remaining companies
      accessSvcMock.demoteInstanceAdmin.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/remove")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ companyId: "comp-1", userId: "user-1" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(accessSvcMock.removeMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
      );
      expect(accessSvcMock.demoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    });

    it("does not demote if user still has other companies", async () => {
      accessSvcMock.removeMembership.mockResolvedValue(undefined);
      accessSvcMock.listUserCompanyAccess.mockResolvedValue([
        { companyId: "comp-2", membershipRole: "owner" },
      ]);

      const res = await request(app)
        .post("/internal/members/remove")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ companyId: "comp-1", userId: "user-1" });

      expect(res.status).toBe(200);
      expect(accessSvcMock.removeMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
      );
      expect(accessSvcMock.demoteInstanceAdmin).not.toHaveBeenCalled();
    });
  });

  describe("POST /internal/members/change-role", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app)
        .post("/internal/members/change-role")
        .send({ companyId: "c1", userId: "u1", role: "admin" });
      expect(res.status).toBe(401);
    });

    it("updates grants and promotes for owner role", async () => {
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" });
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/change-role")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ companyId: "comp-1", userId: "user-1", role: "owner" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "owner",
        "active",
      );
      expect(accessSvcMock.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
      expect(accessSvcMock.setPrincipalGrants).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        expect.arrayContaining([{ permissionKey: "company:delete" }]),
        null,
      );
    });

    it("demotes when changing from owner to member", async () => {
      accessSvcMock.ensureMembership.mockResolvedValue({ id: "m1" });
      accessSvcMock.demoteInstanceAdmin.mockResolvedValue(undefined);
      accessSvcMock.setPrincipalGrants.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/internal/members/change-role")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ companyId: "comp-1", userId: "user-1", role: "member" });

      expect(res.status).toBe(200);
      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "member",
        "active",
      );
      expect(accessSvcMock.demoteInstanceAdmin).toHaveBeenCalledWith("user-1");
      expect(accessSvcMock.setPrincipalGrants).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        [{ permissionKey: "tasks:assign" }],
        null,
      );
    });
  });
});
