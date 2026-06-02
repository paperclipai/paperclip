/**
 * One-shot backfill: set projectId on open issues that have null projectId
 * but an ancestor with a known projectId.
 *
 * Run: node --import tsx/esm server/scripts/backfill-issue-project-ids.ts [--dry-run] [--company <id>]
 * Or:  DATABASE_URL=... pnpm tsx scripts/backfill-issue-project-ids.ts [--dry-run] [--company <id>]
 */
import { loadConfig } from "../server/src/config.js";
import { createDb, companies, issues } from "../packages/db/src/index.js";
import { and, eq, isNull, isNotNull, inArray } from "drizzle-orm";

const OPEN_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const dryRun = process.argv.includes("--dry-run");

async function resolveAncestorProjectId(
  db: ReturnType<typeof createDb>,
  companyId: string,
  parentId: string,
  maxDepth = 15,
): Promise<string | null> {
  let currentId: string | null = parentId;
  for (let i = 0; i < maxDepth && currentId; i++) {
    const [row] = await db
      .select({ projectId: issues.projectId, parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.id, currentId), eq(issues.companyId, companyId)))
      .limit(1);
    if (!row) return null;
    if (row.projectId) return row.projectId;
    currentId = row.parentId;
  }
  return null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const targetCompanyId = parseFlag("--company");
  const companyRows = targetCompanyId
    ? [{ id: targetCompanyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  console.log(
    `Backfilling issue projectIds for ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}...${dryRun ? " [DRY RUN]" : ""}`,
  );

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const company of companyRows) {
    const nullProjectIssues = await db
      .select({ id: issues.id, identifier: issues.identifier, parentId: issues.parentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          isNull(issues.projectId),
          isNotNull(issues.parentId),
          inArray(issues.status, OPEN_STATUSES as unknown as string[]),
        ),
      );

    console.log(`  Company ${company.id}: ${nullProjectIssues.length} open null-project issues with parents`);

    for (const issue of nullProjectIssues) {
      const projectId = await resolveAncestorProjectId(db, company.id, issue.parentId!);
      if (!projectId) {
        totalSkipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  [dry-run] Would set ${issue.identifier} -> projectId=${projectId}`);
      } else {
        await db
          .update(issues)
          .set({ projectId })
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, company.id)));
        console.log(`  ✓ ${issue.identifier} -> projectId=${projectId}`);
      }
      totalUpdated++;
    }
  }

  console.log(
    `\nBackfill complete: ${totalUpdated} updated, ${totalSkipped} skipped (no inferable ancestor).`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Project ID backfill failed: ${message}`);
  process.exitCode = 1;
});
