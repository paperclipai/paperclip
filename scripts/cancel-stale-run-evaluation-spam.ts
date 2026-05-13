/**
 * Bulk-cancel spam evaluation issues created by the stale run watchdog before the
 * reopen fix (MEM-7505). These are duplicate `stale_active_run_evaluation` issues
 * that were created once the rearm window expired — the fix now reopens the existing
 * issue instead.
 *
 * Usage:
 *   npx tsx scripts/cancel-stale-run-evaluation-spam.ts [--company <id>] [--dry-run]
 *
 * Without --company, processes all companies.
 * With --dry-run, prints what would be cancelled without making changes.
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { companies, createDb, issues } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const dryRun = process.argv.includes("--dry-run");
const companyFilter = parseFlag("--company");

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);

  const companyRows = companyFilter
    ? [{ id: companyFilter }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to cancel.");
    return;
  }

  let totalCancelled = 0;

  for (const company of companyRows) {
    // Find all stale_active_run_evaluation issues for this company, grouped by originId.
    // Keep the oldest issue per originId (the original), cancel the rest (the duplicates).
    const allEvals = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        originId: issues.originId,
        status: issues.status,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          eq(issues.originKind, "stale_active_run_evaluation"),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
        ),
      )
      .orderBy(sql`${issues.originId}, ${issues.createdAt} asc`);

    // Group by originId; keep the earliest, cancel the rest
    const byOrigin = new Map<string, typeof allEvals>();
    for (const row of allEvals) {
      if (!row.originId) continue;
      if (!byOrigin.has(row.originId)) byOrigin.set(row.originId, []);
      byOrigin.get(row.originId)!.push(row);
    }

    const toCancel: string[] = [];
    for (const [originId, rows] of byOrigin) {
      if (rows.length <= 1) continue;
      // rows are already sorted by createdAt asc — keep first, cancel the rest
      const duplicates = rows.slice(1);
      console.log(
        `  origin ${originId}: ${rows.length} active evals, cancelling ${duplicates.length} duplicate(s): ${duplicates.map((r) => r.identifier ?? r.id).join(", ")}`,
      );
      toCancel.push(...duplicates.map((r) => r.id));
    }

    if (toCancel.length === 0) {
      console.log(`  company ${company.id}: no duplicate active evaluations found`);
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] would cancel ${toCancel.length} issue(s) for company ${company.id}`);
    } else {
      await db
        .update(issues)
        .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(issues.companyId, company.id), inArray(issues.id, toCancel)));
      console.log(`  cancelled ${toCancel.length} duplicate evaluation issue(s) for company ${company.id}`);
      totalCancelled += toCancel.length;
    }
  }

  if (!dryRun) {
    console.log(`\nDone. Total cancelled: ${totalCancelled}`);
  } else {
    console.log("\n[dry-run complete — no changes made]");
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Cleanup failed: ${message}`);
  process.exitCode = 1;
});
