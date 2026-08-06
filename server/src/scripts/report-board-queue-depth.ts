/**
 * RBR-791 / RBR-802: measure board-queue depth (pending issue-thread
 * interactions) and split it into decisions that are still answerable vs.
 * exhaust pending on issues that are already done/cancelled.
 *
 *   pnpm --filter @paperclipai/server exec tsx src/scripts/report-board-queue-depth.ts \
 *     --company <uuid> [--out report.tsv]
 *
 * This reads the database directly and it is deliberately NOT an API client.
 *
 * RBR-802 F2: the first version of this report counted pending interactions
 * through `GET /issues/:id/interactions`. That route is not a pure read — it
 * calls `expireRequestConfirmationsSupersededByHistoricalComments` and
 * `expirePendingInteractionsForTerminalIssue` before returning the list. For
 * every done/cancelled issue, the pending rows were therefore expired *by the
 * act of reading them* and then counted as 0: the report understated exhaust,
 * trended to zero on re-run, and mutated production while claiming to observe
 * it. The GET-side expiry is pre-existing, load-bearing catch-up behaviour and
 * is not the bug — measuring through it was. A measurement must not perturb
 * what it measures, so this reads the tables.
 *
 * RBR-802 F3: the first version also paged once at `?limit=1000` and would have
 * silently under-reported forever after crossing that boundary. A single
 * grouped SQL aggregate has no page boundary to cross, so the failure mode is
 * gone rather than merely raised.
 */
import { createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";

import { loadConfig } from "../config.js";

const TERMINAL_STATUSES = ["done", "cancelled"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const companyId = parseFlag("--company");
  if (!companyId) throw new Error("--company <uuid> is required");
  const outfile = parseFlag("--out");

  const config = loadConfig();
  const db = createDb(
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`,
  );

  // One grouped read over the join. No pagination, no per-issue round trip, and
  // no write path anywhere in reach.
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      issueStatus: issues.status,
      pendingCount: sql<number>`count(*)::int`,
    })
    .from(issueThreadInteractions)
    .innerJoin(
      issues,
      and(
        eq(issueThreadInteractions.issueId, issues.id),
        eq(issueThreadInteractions.companyId, issues.companyId),
      ),
    )
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
    ))
    .groupBy(issues.id, issues.identifier, issues.status)
    .orderBy(sql`count(*) desc`);

  // Kind breakdown of the exhaust, so the backfill's blast radius is legible
  // before it runs.
  const exhaustByKind = await db
    .select({
      kind: issueThreadInteractions.kind,
      pendingCount: sql<number>`count(*)::int`,
    })
    .from(issueThreadInteractions)
    .innerJoin(
      issues,
      and(
        eq(issueThreadInteractions.issueId, issues.id),
        eq(issueThreadInteractions.companyId, issues.companyId),
      ),
    )
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      inArray(issues.status, [...TERMINAL_STATUSES]),
    ))
    .groupBy(issueThreadInteractions.kind)
    .orderBy(sql`count(*) desc`);

  let total = 0;
  let dead = 0;
  let deadIssues = 0;
  let live = 0;
  let liveIssues = 0;
  const lines: string[] = [];

  for (const row of rows) {
    const count = Number(row.pendingCount);
    total += count;
    const terminal = (TERMINAL_STATUSES as readonly string[]).includes(row.issueStatus);
    if (terminal) {
      dead += count;
      deadIssues += 1;
    } else {
      live += count;
      liveIssues += 1;
    }
    lines.push([row.issueId, row.identifier ?? "", row.issueStatus, String(count)].join("\t"));
  }

  console.log(`company                  : ${companyId}`);
  console.log(`measured at              : ${new Date().toISOString()}`);
  console.log(`source                   : direct DB read (non-mutating)`);
  console.log(`issues with pending asks : ${rows.length}`);
  console.log(`total pending asks       : ${total}`);
  console.log(`  answerable (open)      : ${live} across ${liveIssues} issues`);
  console.log(`  exhaust (done/cancel)  : ${dead} across ${deadIssues} issues`);
  if (total > 0) {
    console.log(`  exhaust share          : ${((dead * 100) / total).toFixed(1)}%`);
  }
  if (exhaustByKind.length > 0) {
    console.log(`exhaust by kind:`);
    for (const row of exhaustByKind) {
      console.log(`  ${row.kind.padEnd(24)} ${row.pendingCount}`);
    }
  }

  if (outfile) {
    writeFileSync(outfile, `${["issueId", "identifier", "issueStatus", "pendingCount"].join("\t")}\n${lines.join("\n")}\n`);
    console.log(`per-issue detail written to ${outfile}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`board queue depth report failed: ${message}`);
  process.exitCode = 1;
});
