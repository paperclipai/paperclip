import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

type SeededMembership = { companyId: string; membershipRole: string; status: string };

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()). The chain is awaitable so
// directly-awaited statements resolve.
function createFakeDb(options?: {
  membershipRow?: SeededMembership;
  seededMemberships?: SeededMembership[];
  /** Rows returned by the SELECT over `companies` — [] means the stack company does not exist yet. */
  companyRows?: Array<{ id: string }>;
}) {
  const membershipRow: SeededMembership =
    options?.membershipRow ?? { companyId: "company-x", membershipRole: "owner", status: "active" };
  const insertedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const selectedTables: unknown[] = [];
  const insertedValues = new Map<unknown, Record<string, unknown>>();
  let currentTable: unknown = null;
  const memberships = options?.seededMemberships ?? [membershipRow];
  const companyRows = options?.companyRows ?? [];
  const chain: Record<string, unknown> = {};
  chain.values = (values: Record<string, unknown>) => {
    if (currentTable !== null) insertedValues.set(currentTable, values);
    return chain;
  };
  chain.onConflictDoUpdate = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = async () => [membershipRow];
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  const db = {
    insert: (table: unknown) => {
      insertedTables.push(table);
      currentTable = table;
      return chain;
    },
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table);
        return { where: async () => (table === companies ? companyRows : memberships) };
      },
    }),
    delete: (table: unknown) => {
      deletedTables.push(table);
      return { where: async () => undefined };
    },
  } as unknown as Db;
  return { db, insertedTables, deletedTables, selectedTables, insertedValues };
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

describe("resolveCloudTenantActor (shared-pool hardening)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  });

  it("never grants instance admin", async () => {
    const { db, insertedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(insertedTables).not.toContain(instanceUserRoles);
  });

  it("is scoped to exactly the one company from its stack", async () => {
    const { db } = createFakeDb({ companyRows: [{ id: "company-x" }] });
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

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("maps a non-owner stack role through to the membership without elevating", async () => {
    const { db } = createFakeDb({
      membershipRow: { companyId: "company-y", membershipRole: "member", status: "active" },
      companyRows: [{ id: "company-y" }],
    });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });

  it("never creates the company (lazy creation)", async () => {
    const { db, insertedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(insertedTables).toContain(authUsers);
    expect(insertedTables).not.toContain(companies);
  });

  it("skips the membership upsert while the stack company does not exist", async () => {
    const { db, insertedTables } = createFakeDb({ companyRows: [], seededMemberships: [] });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).not.toContain(companyMemberships);
    expect(actor!.companyIds).toEqual([]);
    expect(actor!.memberships).toEqual([]);
  });

  it("upserts the membership once the stack company exists", async () => {
    const { db, insertedTables } = createFakeDb({ companyRows: [{ id: "company-x" }] });
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).toContain(companyMemberships);
  });

  it("exposes the stack context on the actor", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.cloudStack).toEqual({ stackId: "stack-abc", stackRole: "owner" });
  });

  it("exposes a non-creator stack role verbatim", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "support" }),
    );
    expect(actor!.cloudStack).toEqual({ stackId: "stack-abc", stackRole: "support" });
  });
});
