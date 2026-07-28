import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()), plus the
// select().from(instanceSettings).where().then() read the owner-elevation flag
// resolution performs through instanceSettingsService. The chain is awaitable so
// directly-awaited statements resolve.
function createFakeDb(options: {
  membershipRow?: { companyId: string; membershipRole: string; status: string };
  settingsRow?: Record<string, unknown> | null;
  selectThrows?: boolean;
} = {}) {
  const membershipRow =
    options.membershipRow ?? { companyId: "company-x", membershipRole: "owner", status: "active" };
  const settingsRow =
    options.settingsRow === undefined
      ? {
          id: "00000000-0000-0000-0000-000000000001",
          singletonKey: "default",
          defaultEnvironmentId: null,
          general: {},
          experimental: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : options.settingsRow;
  const insertedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const chain: Record<string, unknown> = {};
  chain.values = () => chain;
  chain.onConflictDoUpdate = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.where = () => chain;
  chain.returning = async () => [membershipRow];
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  const db = {
    insert: (table: unknown) => {
      insertedTables.push(table);
      return chain;
    },
    delete: (table: unknown) => {
      deletedTables.push(table);
      return chain;
    },
    select: () => {
      if (options.selectThrows) throw new Error("select unavailable");
      return {
        from: (table: unknown) => ({
          where: () => ({
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(table === instanceSettings && settingsRow ? [settingsRow] : []).then(resolve),
          }),
        }),
      };
    },
  } as unknown as Db;
  return { db, insertedTables, deletedTables };
}

function settingsRowWith(experimental: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
    experimental,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

const VALID_HEADERS = {
  "x-paperclip-cloud-tenant-token": "test-server-token",
  "x-paperclip-cloud-user-id": "user-123",
  "x-paperclip-cloud-user-email": "Owner@Example.com",
  "x-paperclip-cloud-stack-id": "stack-abc",
  "x-paperclip-cloud-stack-role": "owner",
};

const MANAGED_CONFIG_FLAG_ON = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "test",
  features: { enableOwnerInstanceAdmin: true },
  plugins: { autoInstall: [] },
});

const MANAGED_CONFIG_FLAG_OFF = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "test",
  features: { enableOwnerInstanceAdmin: false },
  plugins: { autoInstall: [] },
});

describe("resolveCloudTenantActor (shared-pool hardening)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
  });

  it("does not grant instance admin by default (flag off)", async () => {
    const { db, insertedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(insertedTables).not.toContain(instanceUserRoles);
  });

  it("is scoped to exactly the one company from its stack", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.companyIds).toHaveLength(1);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.companyId).toBe(actor?.companyIds?.[0]);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor!.source).toBe("cloud_tenant");
  });

  it("purges stale instance_admin rows left by pre-hardening deployments", async () => {
    const { db, deletedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(deletedTables).toContain(instanceUserRoles);
  });

  it("still upserts the user, company, and membership", async () => {
    const { db, insertedTables } = createFakeDb();
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).toContain(authUsers);
    expect(insertedTables).toContain(companies);
    expect(insertedTables).toContain(companyMemberships);
  });

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("maps a non-owner stack role through to the membership without elevating", async () => {
    const { db } = createFakeDb({
      membershipRow: { companyId: "company-y", membershipRole: "member", status: "active" },
    });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });

  describe("owner instance-admin elevation (enableOwnerInstanceAdmin)", () => {
    it("elevates the owner while the flag is enabled, still without any role row", async () => {
      const { db, insertedTables, deletedTables } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(true);
      expect(actor!.source).toBe("cloud_tenant");
      // Elevation is computed, never persisted: no instance_user_roles insert,
      // and the stale-row purge still runs on every authentication.
      expect(insertedTables).not.toContain(instanceUserRoles);
      expect(deletedTables).toContain(instanceUserRoles);
    });

    it("does not elevate the owner while the flag is disabled", async () => {
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: false }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(false);
    });

    it.each(["member", "admin", "support"] as const)(
      "never elevates the %s stack role even with the flag enabled",
      async (stackRole) => {
        const { db } = createFakeDb({
          membershipRow: { companyId: "company-y", membershipRole: "member", status: "active" },
          settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
        });
        const actor = await resolveCloudTenantActor(
          db,
          fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": stackRole }),
        );
        expect(actor).not.toBeNull();
        expect(actor!.isInstanceAdmin).toBe(false);
      },
    );

    it("resolves the flag through the managed overlay: overlay on elevates over a DB value of off", async () => {
      process.env.PAPERCLIP_MANAGED_CONFIG = MANAGED_CONFIG_FLAG_ON;
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: false }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(true);
    });

    it("resolves the flag through the managed overlay: overlay off wins over a DB value of on", async () => {
      process.env.PAPERCLIP_MANAGED_CONFIG = MANAGED_CONFIG_FLAG_OFF;
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(false);
    });

    it("fails closed when the settings read errors: actor resolves without elevation", async () => {
      const { db, deletedTables } = createFakeDb({ selectThrows: true });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor).not.toBeNull();
      expect(actor!.isInstanceAdmin).toBe(false);
      expect(deletedTables).toContain(instanceUserRoles);
    });
  });
});
