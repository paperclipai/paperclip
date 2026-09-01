import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Hygiene cleanup for rows a pre-fix bug left behind — a non-blocked row
// still carrying blockedTransitionAt (and, sometimes, a stranded
// unblockDescriptor) from before checkout() and update()'s exit branch
// cleared these fields together on every exit from `blocked`. Not a
// suppression-bug fix on its own (the dependency-wakeup backstop only reads
// blockedTransitionAt for rows currently status:"blocked" — see
// issue-dependency-wakeups.ts / recovery/service.ts's
// `eq(issues.status, "blocked")` candidate filter); this closes the loop so
// the field means what its docblock says.
const MIGRATION_FILE = "0238_backfill_stale_blocked_transition_stamps.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("backfill stale blockedTransitionAt stamps migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("clears blockedTransitionAt/unblockDescriptor/blockedOwnerNotifiedAt on non-blocked rows, and leaves blocked rows untouched", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-backfill-stale-blocked-stamp-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind so we can seed the pre-cleanup (stale-stamp) state, then
    // re-run the migration against it.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const companyId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Stale Stamp Co', 'SSC')
    `;

    const staleNonBlockedId = randomUUID();
    const staleWithDescriptorId = randomUUID();
    const cleanBlockedId = randomUUID();
    const cleanNonBlockedId = randomUUID();
    const staleStamp = "2026-06-01T00:00:00.000Z";
    const blockedStamp = "2026-08-31T00:00:00.000Z";

    await sql`
      INSERT INTO "issues" ("id", "company_id", "identifier", "title", "status", "priority", "blocked_transition_at")
      VALUES (${staleNonBlockedId}, ${companyId}, 'SSC-1', 'Stale stamp, back on todo', 'todo', 'medium', ${staleStamp})
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "identifier", "title", "status", "priority", "blocked_transition_at", "unblock_descriptor", "blocked_owner_notified_at")
      VALUES (
        ${staleWithDescriptorId}, ${companyId}, 'SSC-2', 'Stale stamp with stranded descriptor', 'in_progress', 'medium',
        ${staleStamp}, ${sql.json({ owner: { board: true }, action: "Rule on this" })}, ${staleStamp}
      )
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "identifier", "title", "status", "priority", "blocked_transition_at")
      VALUES (${cleanBlockedId}, ${companyId}, 'SSC-3', 'Currently blocked, must be untouched', 'blocked', 'medium', ${blockedStamp})
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "identifier", "title", "status", "priority")
      VALUES (${cleanNonBlockedId}, ${companyId}, 'SSC-4', 'Never blocked, no stamp', 'todo', 'medium')
    `;

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<
      { id: string; status: string; blocked_transition_at: Date | null; unblock_descriptor: unknown; blocked_owner_notified_at: Date | null }[]
    >`
      SELECT "id", "status", "blocked_transition_at", "unblock_descriptor", "blocked_owner_notified_at"
      FROM "issues"
      WHERE "company_id" = ${companyId}
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Stale stamp on a non-blocked row is cleared.
    expect(byId.get(staleNonBlockedId)?.blocked_transition_at).toBeNull();

    // Stale stamp AND the stranded descriptor/notified-at are cleared together
    // (same shape checkout()'s and update()'s exit branch already produce).
    const withDescriptor = byId.get(staleWithDescriptorId);
    expect(withDescriptor?.blocked_transition_at).toBeNull();
    expect(withDescriptor?.unblock_descriptor).toBeNull();
    expect(withDescriptor?.blocked_owner_notified_at).toBeNull();

    // A row currently blocked keeps its stamp untouched.
    expect(byId.get(cleanBlockedId)?.blocked_transition_at?.toISOString()).toBe(blockedStamp);

    // A row with no stamp to begin with stays null (no spurious write).
    expect(byId.get(cleanNonBlockedId)?.blocked_transition_at).toBeNull();
  }, 30_000);
});
