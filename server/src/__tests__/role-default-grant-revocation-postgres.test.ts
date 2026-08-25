import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  principalRoleDefaultSeeds,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { authorizationService } from "../services/authorization.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";
import {
  backfillPrincipalAccessCompatibility,
  ensureHumanRoleDefaultGrants,
} from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Revoking a role default and having it stay revoked.
 *
 * `principal_permission_grants` has no way to say "deliberately revoked":
 * absence is the only representation, and absence is exactly what the
 * role-default seeder is built to fill. So every revocation of a default looked
 * like it took — the row was gone, the UI showed it gone — and then silently
 * reversed the next time any seeding path ran. There are four of those, and
 * none needs a concurrent writer to reach: the startup backfill, a cloud-tenant
 * sync, `setUserCompanyAccess`, and company clone (FAI-10190).
 *
 * These tests are about durability across those paths, which is why almost
 * every one of them revokes and then *re-runs a seeder*. Asserting the row is
 * gone right after the delete proves nothing; it was already true before the
 * fix.
 */
describeEmbeddedPostgres("role-default grant revocation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  /** An `operator` default, and the only key that role carries. */
  const OPERATOR_DEFAULT = "tasks:assign" as const;
  /** An `admin` default the `operator` role has never carried. */
  const ADMIN_ONLY_DEFAULT = "agents:create" as const;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-role-default-revocation-");
    db = createDb(tempDb.connectionString);
  }, 900_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * A company with an owner — so the operator is never the last active owner
   * and can be archived or demoted — and one active `operator` member who has
   * been through the bootstrap already, which is the state every existing
   * member is in.
   */
  async function seedBootstrappedOperator() {
    const company = await db
      .insert(companies)
      .values({
        name: `Role Defaults ${randomUUID()}`,
        issuePrefix: `RD${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `member-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);

    await backfillPrincipalAccessCompatibility(db);
    expect(await permissionKeysFor(company.id, member.principalId)).toContain(OPERATOR_DEFAULT);

    return { companyId: company.id, member };
  }

  async function permissionKeysFor(companyId: string, principalId: string) {
    return db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .then((rows) => rows.map((row) => row.permissionKey));
  }

  async function settledMarker(companyId: string, principalId: string) {
    return db
      .select()
      .from(principalRoleDefaultSeeds)
      .where(
        and(
          eq(principalRoleDefaultSeeds.companyId, companyId),
          eq(principalRoleDefaultSeeds.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function decide(companyId: string, principalId: string, permissionKey: typeof OPERATOR_DEFAULT) {
    return authorizationService(db).decidePrincipalGrant({
      companyId,
      principalType: "user",
      principalId,
      action: permissionKey,
      permissionKey,
    });
  }

  /**
   * The reported defect, and the acceptance criterion, in the shape an operator
   * meets it: revoke one permission, restart the server.
   */
  it("keeps a revoked role default revoked across the startup backfill", async () => {
    const { companyId, member } = await seedBootstrappedOperator();
    const access = accessService(db);

    await access.setPrincipalPermission(
      companyId,
      "user",
      member.principalId,
      OPERATOR_DEFAULT,
      false,
      "revoking-admin",
    );
    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(companyId, member.principalId)).not.toContain(OPERATOR_DEFAULT);
    const decision = await decide(companyId, member.principalId, OPERATOR_DEFAULT);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("deny_missing_grant");
  });

  /**
   * The other three seeding paths, driven directly. A cloud-tenant sync calls
   * the seeder on every sync for the member it just upserted;
   * `setUserCompanyAccess` re-states which companies a user belongs to; and a
   * company clone copies the memberships and seeds each one.
   *
   * The clone is asserted on the *source*: it is the company holding the
   * revocation, and the run must leave it alone. What the clone's own target
   * company gets is a separate decision, covered below.
   */
  it("keeps a revoked role default revoked across a cloud sync, a company access update, and a clone", async () => {
    const { companyId, member } = await seedBootstrappedOperator();
    const access = accessService(db);

    await access.setPrincipalPermission(
      companyId,
      "user",
      member.principalId,
      OPERATOR_DEFAULT,
      false,
      "revoking-admin",
    );

    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: member.principalId,
      membershipRole: "operator",
      grantedByUserId: null,
    });
    expect(await permissionKeysFor(companyId, member.principalId)).not.toContain(OPERATOR_DEFAULT);

    await access.setUserCompanyAccess(member.principalId, [companyId], { actorUserId: "some-admin" });
    expect(await permissionKeysFor(companyId, member.principalId)).not.toContain(OPERATOR_DEFAULT);

    const clone = await db
      .insert(companies)
      .values({
        name: `Clone ${randomUUID()}`,
        issuePrefix: `CL${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    await access.copyActiveUserMemberships(companyId, clone.id);

    expect(await permissionKeysFor(companyId, member.principalId)).not.toContain(OPERATOR_DEFAULT);
    expect((await decide(companyId, member.principalId, OPERATOR_DEFAULT)).allowed).toBe(false);
    // The clone is a different company, so its copy of this member has never
    // been bootstrapped and gets the role's defaults. Revocations are scoped to
    // the company they were made in; a clone does not inherit them, because it
    // does not inherit the grants they were made against either.
    expect(await permissionKeysFor(clone.id, member.principalId)).toContain(OPERATOR_DEFAULT);
  });

  /**
   * The audit half. A missing grant row is the same shape whether it was
   * revoked or never held, so the marker records the role that was settled and
   * the reader recovers the difference from it (acceptance criterion 2).
   */
  it("records the settled role, so a revoked default is distinguishable from one never carried", async () => {
    const { companyId, member } = await seedBootstrappedOperator();

    await accessService(db).setPrincipalPermission(
      companyId,
      "user",
      member.principalId,
      OPERATOR_DEFAULT,
      false,
      "revoking-admin",
    );

    const marker = await settledMarker(companyId, member.principalId);
    expect(marker?.role).toBe("operator");
    expect(marker?.settledByUserId).toBe("revoking-admin");

    const roleDefaults = grantsForHumanRole("operator").map((grant) => grant.permissionKey);
    const held = await permissionKeysFor(companyId, member.principalId);
    const revoked = roleDefaults.filter((key) => !held.includes(key));
    expect(revoked).toEqual([OPERATOR_DEFAULT]);
    // Never carried reads differently: it is not in the settled role's defaults
    // at all, so it never appears in that subtraction.
    expect(roleDefaults).not.toContain(ADMIN_ONLY_DEFAULT);
    expect(held).not.toContain(ADMIN_ONLY_DEFAULT);
  });

  /**
   * The bootstrap has to survive being turned into a one-shot. Removal deletes
   * a principal's grants, so the marker goes with them — otherwise a re-added
   * member arrives with no permissions at all instead of their role's defaults,
   * which would be a worse bug than the one being fixed.
   */
  it("bootstraps a member again after they are removed and re-added", async () => {
    const { companyId, member } = await seedBootstrappedOperator();
    const access = accessService(db);

    await access.archiveMember(companyId, member.id);
    expect(await permissionKeysFor(companyId, member.principalId)).toHaveLength(0);
    expect(await settledMarker(companyId, member.principalId)).toBeNull();

    await access.ensureMembership(companyId, "user", member.principalId, "operator", "active");
    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(companyId, member.principalId)).toContain(OPERATOR_DEFAULT);
    expect((await decide(companyId, member.principalId, OPERATOR_DEFAULT)).allowed).toBe(true);
  });

  /**
   * The same rule on the other removal path, which archives across several
   * companies at once by leaving a user's company list.
   */
  it("bootstraps a member again after company access is taken away and restored", async () => {
    const { companyId, member } = await seedBootstrappedOperator();
    const access = accessService(db);

    await access.setUserCompanyAccess(member.principalId, [], { actorUserId: "some-admin" });
    expect(await permissionKeysFor(companyId, member.principalId)).toHaveLength(0);
    expect(await settledMarker(companyId, member.principalId)).toBeNull();

    await access.setUserCompanyAccess(member.principalId, [companyId], { actorUserId: "some-admin" });
    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(companyId, member.principalId)).toContain(OPERATOR_DEFAULT);
  });

  /**
   * Seed-once is per role, not per principal, so a promotion still hands over
   * the new role's defaults — the marker no longer matches and the bootstrap
   * runs again for that role. Only a new key added to a role someone already
   * holds stops propagating, which is the documented trade in
   * `grantsForHumanRole`.
   */
  it("applies the new role's defaults when a member is promoted", async () => {
    const { companyId, member } = await seedBootstrappedOperator();
    const access = accessService(db);

    expect(await permissionKeysFor(companyId, member.principalId)).not.toContain(ADMIN_ONLY_DEFAULT);

    await access.updateMember(companyId, member.id, { membershipRole: "admin" });
    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(companyId, member.principalId)).toContain(ADMIN_ONLY_DEFAULT);
    expect((await settledMarker(companyId, member.principalId))?.role).toBe("admin");
  });

  /**
   * The narrowing that arrives before the bootstrap ever runs. The invite and
   * plugin flows create a membership and then state its whole grant set, which
   * can be deliberately smaller than the role's defaults — an empty set is the
   * extreme. The seeder read that as a gap and filled it.
   */
  it("does not widen a grant set that was written narrower than the role's defaults", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Narrowed ${randomUUID()}`,
        issuePrefix: `NA${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const principalId = `invitee-${randomUUID()}`;
    const access = accessService(db);

    await access.ensureMembership(company.id, "user", principalId, "operator", "active");
    await access.setPrincipalGrants(company.id, "user", principalId, [], "inviting-admin");

    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(company.id, principalId)).toHaveLength(0);
    expect((await decide(company.id, principalId, OPERATOR_DEFAULT)).allowed).toBe(false);
  });

  /**
   * A role with no defaults still gets a marker. Nothing is inserted for a
   * viewer, so without one the seeder could not tell "settled as a viewer" from
   * "never seeded", and the audit subtraction above would have no baseline.
   */
  it("marks a viewer as settled even though the role seeds nothing", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Viewer ${randomUUID()}`,
        issuePrefix: `VW${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const principalId = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: "viewer",
    });

    await backfillPrincipalAccessCompatibility(db);

    expect(await permissionKeysFor(company.id, principalId)).toHaveLength(0);
    expect((await settledMarker(company.id, principalId))?.role).toBe("viewer");
  });
});
