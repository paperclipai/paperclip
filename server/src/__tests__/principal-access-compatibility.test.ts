import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";
import {
  ensureHumanRoleDefaultGrants,
  insertMissingPrincipalGrants,
} from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres principal grant tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("insertMissingPrincipalGrants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-principal-grants-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `Grant Seeding ${randomUUID()}`,
        issuePrefix: `GS${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function grantKeys(companyId: string, principalId: string) {
    const rows = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      );
    return rows.map((row) => row.permissionKey).sort();
  }

  it("inserts only the grants that are missing", async () => {
    const company = await createCompany();
    const userId = `user-${randomUUID()}`;
    const ownerGrants = grantsForHumanRole("owner");
    await insertMissingPrincipalGrants(db, {
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      grants: ownerGrants.slice(0, 2),
      grantedByUserId: null,
    });

    const inserted = await ensureHumanRoleDefaultGrants(db, {
      companyId: company.id,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });

    expect(inserted).toBe(ownerGrants.length - 2);
    expect(await grantKeys(company.id, userId)).toEqual(
      ownerGrants.map((grant) => grant.permissionKey).sort(),
    );
    await expect(
      ensureHumanRoleDefaultGrants(db, {
        companyId: company.id,
        principalId: userId,
        membershipRole: "owner",
        grantedByUserId: null,
      }),
    ).resolves.toBe(0);
  });

  it("does not wait on a transaction that is deleting grants that already exist", async () => {
    const company = await createCompany();
    const userId = `user-${randomUUID()}`;
    await ensureHumanRoleDefaultGrants(db, {
      companyId: company.id,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });
    const rollback = new Error("rollback");
    // A permission edit deletes and re-inserts a member's grants inside one
    // transaction. Until it commits, an INSERT ... ON CONFLICT on the same keys
    // must wait for it.
    const holder = db
      .transaction(async (tx) => {
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, company.id),
              eq(principalPermissionGrants.principalId, userId),
            ),
          );
        signalLockHeld();
        await lockReleased;
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });

    try {
      await lockHeld;
      const seeding = ensureHumanRoleDefaultGrants(db, {
        companyId: company.id,
        principalId: userId,
        membershipRole: "owner",
        grantedByUserId: null,
      });
      const outcome = await Promise.race([
        seeding,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);
      expect(outcome).toBe(0);
    } finally {
      releaseLock();
      await holder;
    }
  });
});
