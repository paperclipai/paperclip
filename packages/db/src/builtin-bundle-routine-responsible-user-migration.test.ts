
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0450_builtin_bundle_routine_responsible_user.sql";
const MARKER = "built-in-bundles";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("built-in bundle routine responsible user migration", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("replaces the synthetic bundle actor with the company default, or its first active owner", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundle-responsible-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const defaultCompanyId = randomUUID();
    const ownerOnlyCompanyId = randomUUID();
    const unresolvedCompanyId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix", "default_responsible_user_id")
      VALUES
        (${defaultCompanyId}, 'Default', 'DEF', 'default-user'),
        (${ownerOnlyCompanyId}, 'Owner only', 'OWN', NULL),
        (${unresolvedCompanyId}, 'Unresolved', 'UNR', NULL)
    `;
    await sql`
      INSERT INTO "company_memberships" ("company_id", "principal_type", "principal_id", "status", "membership_role", "created_at")
      VALUES
        (${ownerOnlyCompanyId}, 'user', 'owner-second', 'active', 'owner', now() + interval '1 minute'),
        (${ownerOnlyCompanyId}, 'user', 'owner-first', 'active', 'owner', now()),
        (${ownerOnlyCompanyId}, 'user', 'plain-member', 'active', 'member', now()),
        (${unresolvedCompanyId}, 'user', 'pending-owner', 'pending', 'owner', now())
    `;

    const routineIds = {
      defaultOwned: randomUUID(),
      revisionFollowsRoutine: randomUUID(),
      alreadyResolved: randomUUID(),
      ownerOwned: randomUUID(),
      unresolvable: randomUUID(),
    };
    const revisionIds = {
      defaultOwned: randomUUID(),
      revisionFollowsRoutine: randomUUID(),
      alreadyResolved: randomUUID(),
      ownerOwned: randomUUID(),
      unresolvable: randomUUID(),
    };
    const poisonedSnapshot = { routine: { responsibleUserId: MARKER }, triggers: [] };
    const resolvedSnapshot = { routine: { responsibleUserId: "operator-user" }, triggers: [] };

    await sql`
      INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
      VALUES
        (${routineIds.defaultOwned}, ${defaultCompanyId}, 'Poisoned', ${MARKER}),
        (${routineIds.revisionFollowsRoutine}, ${defaultCompanyId}, 'Operator owns the routine', 'operator-user'),
        (${routineIds.alreadyResolved}, ${defaultCompanyId}, 'Already resolved', 'existing-user'),
        (${routineIds.ownerOwned}, ${ownerOnlyCompanyId}, 'Poisoned', ${MARKER}),
        (${routineIds.unresolvable}, ${unresolvedCompanyId}, 'Poisoned', ${MARKER})
    `;
    await sql`
      INSERT INTO "routine_revisions" ("id", "company_id", "routine_id", "revision_number", "title", "snapshot", "responsible_user_id")
      VALUES
        (${revisionIds.defaultOwned}, ${defaultCompanyId}, ${routineIds.defaultOwned}, 1, 'Poisoned', ${sql.json(poisonedSnapshot)}, ${MARKER}),
        (${revisionIds.revisionFollowsRoutine}, ${defaultCompanyId}, ${routineIds.revisionFollowsRoutine}, 1, 'Operator owns the routine', ${sql.json(poisonedSnapshot)}, ${MARKER}),
        (${revisionIds.alreadyResolved}, ${defaultCompanyId}, ${routineIds.alreadyResolved}, 1, 'Already resolved', ${sql.json(resolvedSnapshot)}, 'operator-user'),
        (${revisionIds.ownerOwned}, ${ownerOnlyCompanyId}, ${routineIds.ownerOwned}, 1, 'Poisoned', ${sql.json(poisonedSnapshot)}, ${MARKER}),
        (${revisionIds.unresolvable}, ${unresolvedCompanyId}, ${routineIds.unresolvable}, 1, 'Poisoned', ${sql.json(poisonedSnapshot)}, ${MARKER})
    `;

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{ routine_id: string; responsible_user_id: string; snapshot_owner: string | null }[]>`
      SELECT "routine_id", "responsible_user_id", "snapshot" #>> '{routine,responsibleUserId}' AS "snapshot_owner"
      FROM "routine_revisions"
    `;
    const revisionByRoutine = new Map(rows.map((row) => [row.routine_id, row]));
    const routines = await sql<{ id: string; responsible_user_id: string }[]>`
      SELECT "id", "responsible_user_id" FROM "routines"
    `;
    const routineOwner = new Map(routines.map((row) => [row.id, row.responsible_user_id]));

    expect(routineOwner.get(routineIds.defaultOwned)).toBe("default-user");
    expect(revisionByRoutine.get(routineIds.defaultOwned)).toMatchObject({
      responsible_user_id: "default-user",
      snapshot_owner: "default-user",
    });

    expect(routineOwner.get(routineIds.ownerOwned)).toBe("owner-first");
    expect(revisionByRoutine.get(routineIds.ownerOwned)).toMatchObject({
      responsible_user_id: "owner-first",
      snapshot_owner: "owner-first",
    });

    expect(routineOwner.get(routineIds.revisionFollowsRoutine)).toBe("operator-user");
    expect(revisionByRoutine.get(routineIds.revisionFollowsRoutine)).toMatchObject({
      responsible_user_id: "operator-user",
      snapshot_owner: "operator-user",
    });

    expect(routineOwner.get(routineIds.alreadyResolved)).toBe("existing-user");
    expect(revisionByRoutine.get(routineIds.alreadyResolved)).toMatchObject({
      responsible_user_id: "operator-user",
      snapshot_owner: "operator-user",
    });

    expect(routineOwner.get(routineIds.unresolvable)).toBe(MARKER);
    expect(revisionByRoutine.get(routineIds.unresolvable)).toMatchObject({
      responsible_user_id: MARKER,
      snapshot_owner: MARKER,
    });
  }, 60_000);
});
