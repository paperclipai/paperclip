import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../middleware/auth.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CLOUD_PROVISIONING_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SERVER_TOKEN = "test-server-token";

function tenantHeaders(userId: string, stackRole: string) {
  return cloudActorHeaderSourceFromHeaders({
    "x-paperclip-cloud-tenant-token": SERVER_TOKEN,
    "x-paperclip-cloud-user-id": userId,
    "x-paperclip-cloud-user-email": `${userId}@example.com`,
    "x-paperclip-cloud-stack-id": `stack-${userId}`,
    "x-paperclip-cloud-stack-role": stackRole,
  });
}

const writes = (statements: { sql: string }[]) =>
  statements.filter((entry) => /^\s*(delete|insert|update)\b/i.test(entry.sql)).map((entry) => entry.sql);

describeEmbeddedPostgres("cloud tenant actor statements per request", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let meter!: ReturnType<typeof meterDatabaseStatements>;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tenant-statements-");
    const url = external ?? tempDb!.connectionString;
    db = createDb(url);
    meter = meterDatabaseStatements(db, url);
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = SERVER_TOKEN;
  }, 30_000);

  afterAll(async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    meter?.uninstall();
    await db?.delete(activityLog);
    await db?.delete(principalPermissionGrants);
    await db?.delete(companyMemberships);
    await db?.delete(companies);
    await db?.delete(instanceUserRoles);
    await db?.delete(authUsers);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function resolveMetered(userId: string, stackRole: string) {
    const before = meter.read();
    meter.startLog();
    const actor = await resolveCloudTenantActor(db, tenantHeaders(userId, stackRole));
    const statements = meter.stopLog();
    return { actor, statements, count: meter.read().statements - before.statements };
  }

  async function staleAdminRows(userId: string) {
    return db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  }

  it("sends one read and no write for an unchanged authenticated request", async () => {
    await resolveCloudTenantActor(db, tenantHeaders("user-steady", "member"));
    const { actor, statements, count } = await resolveMetered("user-steady", "member");
    expect(actor).toMatchObject({ type: "board", userId: "user-steady", isInstanceAdmin: false });
    expect(writes(statements)).toEqual([]);
    expect(count).toBe(1);
  });

  it("purges a stale instance_admin row on the very next request", async () => {
    await resolveCloudTenantActor(db, tenantHeaders("user-stale", "member"));
    await db.insert(instanceUserRoles).values({ userId: "user-stale", role: "instance_admin" });
    expect(await staleAdminRows("user-stale")).toHaveLength(1);

    const { actor, statements } = await resolveMetered("user-stale", "member");
    expect(actor).toMatchObject({ isInstanceAdmin: false });
    expect(writes(statements)).toEqual([expect.stringMatching(/^delete from "instance_user_roles"/)]);
    expect(await staleAdminRows("user-stale")).toHaveLength(0);

    const next = await resolveMetered("user-stale", "member");
    expect(writes(next.statements)).toEqual([]);
  });

  it("applies a stack role added or removed in the header on the very next request", async () => {
    const member = await resolveMetered("user-roles", "member");
    expect(member.actor?.memberships?.[0]?.membershipRole).toBe("member");
    expect(member.actor?.canManageExperimentalSettings).toBe(false);

    const admin = await resolveMetered("user-roles", "admin");
    expect(admin.actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(admin.actor?.canManageExperimentalSettings).toBe(true);

    const demoted = await resolveMetered("user-roles", "member");
    expect(demoted.actor?.memberships?.[0]?.membershipRole).toBe("member");
    expect(demoted.actor?.canManageExperimentalSettings).toBe(false);
    const [stored] = await db.select({ membershipRole: companyMemberships.membershipRole }).from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, "user-roles")));
    expect(stored?.membershipRole).toBe("member");
  });
});
