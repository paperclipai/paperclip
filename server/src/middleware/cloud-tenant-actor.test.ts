import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "./auth.js";

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()), plus the
// select().from(table).where() reads: instanceSettings for the owner-elevation
// flag resolution through instanceSettingsService, and companyMemberships for
// the user's own membership rows (rows configurable via membershipQueryRows,
// where-conditions captured in selectWheres). The chain is awaitable so
// directly-awaited statements resolve.
function createFakeDb(options: {
  membershipRow?: { companyId: string; membershipRole: string; status: string };
  membershipQueryRows?: Array<{ companyId: string; membershipRole: string | null; status: string }>;
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
  const selectWheres: Array<{ table: unknown; condition: unknown }> = [];
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
          where: (condition: unknown) => {
            selectWheres.push({ table, condition });
            const rows =
              table === instanceSettings && settingsRow
                ? [settingsRow]
                : table === companyMemberships
                  ? (options.membershipQueryRows ?? [])
                  : [];
            return {
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
            };
          },
        }),
      };
    },
  } as unknown as Db;
  return { db, insertedTables, deletedTables, selectWheres };
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

  it("stays scoped to exactly the stack's company when the user has no other membership rows", async () => {
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

  it("resyncs an A to B to A context transition inside the debounce window", async () => {
    const { db, insertedTables } = createFakeDb();
    const contextA = VALID_HEADERS;
    const contextB = { ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" };

    await resolveCloudTenantActor(db, fakeReq(contextA));
    await resolveCloudTenantActor(db, fakeReq(contextB));
    await resolveCloudTenantActor(db, fakeReq(contextA));

    expect(insertedTables.filter((table) => table === authUsers)).toHaveLength(3);
    expect(insertedTables.filter((table) => table === companyMemberships)).toHaveLength(3);
  });

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("resolves identically from a raw upgrade-request header map via the shim", async () => {
    // Websocket upgrades hand us IncomingMessage.headers (lowercased keys,
    // possibly string[] values), not an Express Request. The shim must feed
    // resolveCloudTenantActor the same way Express header() does.
    const { db } = createFakeDb();
    const rawHeaders: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(VALID_HEADERS)) rawHeaders[k.toLowerCase()] = v;
    rawHeaders["x-paperclip-cloud-user-name"] = ["Cloud Owner", "ignored-duplicate"];
    const actor = await resolveCloudTenantActor(db, cloudActorHeaderSourceFromHeaders(rawHeaders));
    expect(actor).not.toBeNull();
    expect(actor!.userId).toBe("user-123");
    expect(actor!.userName).toBe("Cloud Owner");
    expect(actor!.companyIds).toHaveLength(1);
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

  describe("company membership union", () => {
    // The primary company id is derived from the stack id; resolve it once
    // through the same code path instead of duplicating the hash here.
    async function resolvePrimaryCompanyId() {
      const { db } = createFakeDb();
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      return actor!.companyIds![0]!;
    }

    it("unions the pinned primary with the user's own active membership rows, primary first and deduped", async () => {
      const primaryCompanyId = await resolvePrimaryCompanyId();
      const { db } = createFakeDb({
        membershipQueryRows: [
          // The user's own row for the primary company comes back from the
          // query too — it must not appear twice.
          { companyId: primaryCompanyId, membershipRole: "owner", status: "active" },
          { companyId: "company-imported", membershipRole: "member", status: "active" },
        ],
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.companyIds).toEqual([primaryCompanyId, "company-imported"]);
      expect(actor!.memberships).toEqual([
        { companyId: primaryCompanyId, membershipRole: "owner", status: "active" },
        { companyId: "company-imported", membershipRole: "member", status: "active" },
      ]);
    });

    it("loads memberships with the session path's exact own-user active-status filter", async () => {
      const { db, selectWheres } = createFakeDb();
      await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      const membershipSelects = selectWheres.filter((entry) => entry.table === companyMemberships);
      expect(membershipSelects).toHaveLength(1);
      // Rows for other users and rows in any non-active status are excluded
      // by the query itself: the filter binds exactly this user id and the
      // "active" status — the same condition the session path applies.
      expect(membershipSelects[0]!.condition).toEqual(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, "user-123"),
          eq(companyMemberships.status, "active"),
        ),
      );
    });

    it("degrades to the primary company when the membership read fails", async () => {
      const { db } = createFakeDb({ selectThrows: true });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor).not.toBeNull();
      expect(actor!.companyIds).toHaveLength(1);
      expect(actor!.memberships).toHaveLength(1);
    });
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
