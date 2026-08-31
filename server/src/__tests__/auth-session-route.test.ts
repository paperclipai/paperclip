import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import {
  actorMiddleware,
  humanizeCloudStackSlug,
  isKnownBadCloudCompanyName,
} from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertCompanyAccess } from "../routes/authz.js";

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

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
  });

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      delete: vi.fn(() => ({ where: () => Promise.resolve(undefined) })),
      select: vi.fn(() => createSelectChain([])),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-name", "Purple Rain")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: false,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    // authUsers, companies, companyMemberships, the role-default
    // principalPermissionGrants, and the lazily initialized instance setting.
    expect(inserts).toHaveLength(5);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
    expect(inserts[1]?.values).toMatchObject({
      name: "Purple Rain",
    });
  });

  it("lets the cloud tenant actor through assertCompanyAccess for a company it holds a membership row in", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    // A company created on the instance after provisioning (e.g. by a company
    // import) — the user has a real membership row, but it is not the stack's
    // seeded primary company.
    const importedCompanyId = "33333333-3333-4333-8333-333333333333";
    const unrelatedCompanyId = "44444444-4444-4444-8444-444444444444";
    const insertChain = {
      values() {
        return insertChain;
      },
      onConflictDoUpdate() {
        return insertChain;
      },
      onConflictDoNothing() {
        return insertChain;
      },
      returning() {
        return Promise.resolve([{ companyId: "company-1", membershipRole: "member", status: "active" }]);
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === companyMemberships
                ? [{ companyId: importedCompanyId, membershipRole: "member", status: "active" }]
                : [],
            ),
        }),
      })),
      insert: vi.fn(() => insertChain),
      delete: vi.fn(() => ({ where: () => Promise.resolve(undefined) })),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/companies/:companyId/resource", (req, res) => {
      assertCompanyAccess(req, req.params.companyId);
      res.json({ ok: true, companyIds: req.actor.companyIds });
    });
    app.post("/companies/:companyId/resource", (req, res) => {
      assertCompanyAccess(req, req.params.companyId);
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const cloudHeaders = {
      "x-paperclip-cloud-tenant-token": "tenant-token",
      "x-paperclip-cloud-user-id": "global-user-1",
      "x-paperclip-cloud-user-email": "owner@example.com",
      "x-paperclip-cloud-stack-id": "stack-alpha",
      "x-paperclip-cloud-stack-role": "member",
    };

    // Reads and writes both reach the imported company through the real
    // membership row (write access also consults actor.memberships).
    const read = await request(app).get(`/companies/${importedCompanyId}/resource`).set(cloudHeaders);
    expect(read.status).toBe(200);
    expect(read.body.companyIds).toContain(importedCompanyId);

    const write = await request(app).post(`/companies/${importedCompanyId}/resource`).set(cloudHeaders);
    expect(write.status).toBe(200);

    // Companies the user holds no membership row in stay unreachable.
    const denied = await request(app).get(`/companies/${unrelatedCompanyId}/resource`).set(cloudHeaders);
    expect(denied.status).toBe(403);
  });

  it("repairs a legacy machine company name from the trusted human-name header", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const updates: Array<Record<string, unknown>> = [];
    const activities: Array<Record<string, unknown>> = [];
    const insertChain = {
      values() {
        return insertChain;
      },
      onConflictDoUpdate() {
        return insertChain;
      },
      onConflictDoNothing() {
        return insertChain;
      },
      returning() {
        return Promise.resolve([
          { companyId: "company-1", membershipRole: "owner", status: "active" },
        ]);
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === companies
                ? [{ name: "paperclip-stack-purple-rain" }]
                : [],
            ),
        }),
      })),
      insert: vi.fn((table: unknown) => {
        if (table !== activityLog) return insertChain;
        return {
          values(values: Record<string, unknown>) {
            activities.push(values);
            return Promise.resolve(undefined);
          },
        };
      }),
      update: vi.fn(() => ({
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: "company-1" }]),
            }),
          };
        },
      })),
      delete: vi.fn(() => ({ where: () => Promise.resolve(undefined) })),
    } as any;
    db.transaction = vi.fn(async (run: (tx: typeof db) => Promise<void>) => run(db));
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => res.json(req.actor));

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-stack-id", "stack-purple-rain")
      .set(
        "x-paperclip-cloud-paperclip-company-id",
        "paperclip-stack-purple-rain",
      )
      .set("x-paperclip-cloud-paperclip-company-name", "Purple Rain")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ name: "Purple Rain" });
    expect(activities).toEqual([
      expect.objectContaining({
        companyId: expect.any(String),
        actorType: "system",
        actorId: "cloud-tenant-auth",
        action: "company.updated",
        entityType: "company",
        details: expect.objectContaining({
          reason: "legacy_machine_name_repair",
          previousName: "paperclip-stack-purple-rain",
          name: "Purple Rain",
        }),
      }),
    ]);
  });

  it("purges a stale instance_admin row so the session path stops elevating the cloud-tenant user", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    // Simulates a deployment that previously ran the pre-hardening cloud_tenant
    // path: instance_user_roles still holds an instance_admin row for the
    // tenant user, who can also resolve a BetterAuth session for the same id.
    const state = { staleInstanceAdminRow: true };
    const insertChain = {
      values() {
        return insertChain;
      },
      onConflictDoUpdate() {
        return insertChain;
      },
      onConflictDoNothing() {
        return insertChain;
      },
      returning() {
        return Promise.resolve([{ companyId: "company-1", membershipRole: "owner", status: "active" }]);
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === instanceUserRoles && state.staleInstanceAdminRow ? [{ id: "stale-role-row" }] : [],
            ),
        }),
      })),
      insert: vi.fn(() => insertChain),
      delete: vi.fn((table: unknown) => ({
        where: () => {
          if (table === instanceUserRoles) state.staleInstanceAdminRow = false;
          return Promise.resolve(undefined);
        },
      })),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "global-user-1" },
          user: { id: "global-user-1", name: "Stack Owner", email: "owner@example.com" },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    // Control: while the stale row exists, the session path still elevates.
    const before = await request(app).get("/actor");
    expect(before.body).toMatchObject({ source: "session", isInstanceAdmin: true });

    // One trusted-header authentication purges the stale grant.
    const cloud = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");
    expect(cloud.body).toMatchObject({ source: "cloud_tenant", isInstanceAdmin: false });
    expect(state.staleInstanceAdminRow).toBe(false);

    // The same user no longer gets instance admin via the session path.
    const after = await request(app).get("/actor");
    expect(after.body).toMatchObject({
      source: "session",
      userId: "global-user-1",
      isInstanceAdmin: false,
    });
  });
});

describe("Cloud tenant company naming", () => {
  const ids = {
    companyId: "11111111-1111-4111-8111-111111111111",
    paperclipCompanyId: "paperclip-stack-purple-rain",
  };

  it.each([
    "paperclip-stack-purple-rain",
    "stack-purple-rain Paperclip",
    ids.companyId,
  ])("repairs the known-bad machine name %s", (name) => {
    expect(isKnownBadCloudCompanyName(name, ids)).toBe(true);
  });

  it.each([
    "Purple Rain",
    "Paperclip Stack Purple Rain",
    "The Purple Rain Paperclip",
  ])("preserves the genuine company name %s", (name) => {
    expect(isKnownBadCloudCompanyName(name, ids)).toBe(false);
  });

  it("humanizes the stack slug for old harnesses without a name header", () => {
    expect(humanizeCloudStackSlug("stack-purple-rain")).toBe("Purple Rain");
    expect(humanizeCloudStackSlug("paperclip-stack-purple-rain")).toBe(
      "Purple Rain",
    );
  });
});
