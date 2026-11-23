import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("commentary permission upgrade", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-commentary-permission-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  afterAll(async () => { await temporary?.cleanup(); });

  it("grants existing active humans commentary access once without widening audit or existing scopes", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Commentary upgrade", issuePrefix: "UPG" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTH" },
    ]);
    const activeHumans = ["owner", "admin", "operator", "viewer", "member", null].map((membershipRole) => ({
      companyId, principalType: "user", principalId: randomUUID(), membershipRole, status: "active",
    }));
    const excluded = [
      { companyId, principalType: "user", principalId: randomUUID(), membershipRole: "viewer", status: "inactive" },
      { companyId, principalType: "agent", principalId: randomUUID(), membershipRole: "member", status: "active" },
      { companyId: otherCompanyId, principalType: "user", principalId: activeHumans[0].principalId, membershipRole: "owner", status: "inactive" },
    ];
    await db.insert(companyMemberships).values([...activeHumans, ...excluded]);
    const [existing] = await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: activeHumans[0].principalId,
      permissionKey: "commentary:view", scope: { agentIds: [randomUUID()] }, grantedByUserId: "custom-author",
    }).returning();
    const migration = await readFile(new URL(
      "../../../packages/db/src/migrations/0359_commentary_view_human_defaults.sql", import.meta.url,
    ), "utf8");
    await db.execute(sql.raw(migration));
    const first = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    expect(first).toHaveLength(activeHumans.length);
    expect(first.every((grant) => grant.permissionKey === "commentary:view")).toBe(true);
    expect(first.map((grant) => grant.principalId).sort()).toEqual(activeHumans.map((member) => member.principalId).sort());
    expect(first.find((grant) => grant.id === existing.id)).toEqual(existing);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, otherCompanyId))).toEqual([]);

    await db.execute(sql.raw(migration));
    const second = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    expect(second.sort((a, b) => a.id.localeCompare(b.id))).toEqual(first.sort((a, b) => a.id.localeCompare(b.id)));
  });
});
