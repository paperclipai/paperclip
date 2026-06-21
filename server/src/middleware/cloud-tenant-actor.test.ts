import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()). The chain is awaitable so
// directly-awaited statements resolve.
function createFakeDb(membershipRow = { companyId: "company-x", membershipRole: "owner", status: "active" }) {
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
  } as unknown as Db;
  return { db, insertedTables, deletedTables };
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
    const { db } = createFakeDb({ companyId: "company-y", membershipRole: "member", status: "active" });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });
});
