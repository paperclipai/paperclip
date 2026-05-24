/**
 * One-time backfill: scan existing issues for production/runtime/DB keywords
 * and, when no meaningful execution policy exists, inject Quinn (the company's
 * QA agent) as a required reviewer stage.
 *
 * Usage:
 *   npx tsx scripts/backfill-qa-gate.ts [--company <uuid>] [--dry-run]
 *
 * Flags:
 *   --company  Restrict to a single company (default: all companies)
 *   --dry-run  Report what would change without updating the database
 */
import { and, eq, like, or, sql } from "drizzle-orm";
import { agents, companies, issues, issueLabels, labels } from "../packages/db/src/schema/index.js";
import { createDb } from "../packages/db/src/index.js";
import {
  normalizeIssueExecutionPolicy,
  QA_GATE_RE,
} from "../server/src/services/issue-execution-policy.js";
import { loadConfig } from "../server/src/config.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.indexOf(name) >= 0;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const dryRun = hasFlag("--dry-run");
  const companyFilter = parseFlag("--company");

  const companyRows = companyFilter
    ? [{ id: companyFilter }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Backfilling QA gate for ${companyRows.length} company${companyRows.length === 1 ? "" : "ies"}...`,
  );

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const company of companyRows) {
    // Find the QA agent for this company
    const qaAgent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.role, "qa")))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!qaAgent) {
      console.log(`  [${company.id}] No QA agent found, skipping`);
      continue;
    }

    // Find all non-done, non-cancelled issues that match the QA gate pattern
    // but lack a meaningful execution policy
    const candidateIssues = await db
      .select({ id: issues.id, title: issues.title, description: issues.description, executionPolicy: issues.executionPolicy, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          or(
            like(issues.title, "%production%"),
            like(issues.title, "%deploy%"),
            like(issues.title, "%database%"),
            like(issues.title, "%db %"),
            like(issues.title, "%schema%"),
            like(issues.title, "%runtime%"),
            like(issues.description ?? "", "%production%"),
            like(issues.description ?? "", "%deploy%"),
            like(issues.description ?? "", "%database%"),
            like(issues.description ?? "", "%db %"),
            like(issues.description ?? "", "%schema%"),
            like(issues.description ?? "", "%runtime%"),
          ),
        ),
      );

    let companyUpdated = 0;
    let companySkipped = 0;

    for (const issue of candidateIssues) {
      const textToCheck = `${issue.title} ${issue.description ?? ""}`;
      if (!QA_GATE_RE.test(textToCheck)) {
        companySkipped++;
        continue;
      }

      // Skip issues that already have a meaningful execution policy
      const normalized = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
      if (normalized) {
        companySkipped++;
        continue;
      }

      const qaStagePolicy = {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "agent", agentId: qaAgent.id }],
          },
        ],
      };

      if (dryRun) {
        console.log(
          `  [${company.id}] WOULD update issue ${issue.id} (${issue.status}): "${issue.title.slice(0, 60)}"`,
        );
      } else {
        await db
          .update(issues)
          .set({ executionPolicy: qaStagePolicy as Record<string, unknown> })
          .where(eq(issues.id, issue.id));
      }

      companyUpdated++;
    }

    console.log(
      `  [${company.id}] ${dryRun ? "Would update" : "Updated"}: ${companyUpdated}, Skipped (already has policy or no match): ${companySkipped}`,
    );
    totalUpdated += companyUpdated;
    totalSkipped += companySkipped;
  }

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Done. Would update: ${totalUpdated}, Skipped: ${totalSkipped}`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`QA gate backfill failed: ${message}`);
  process.exitCode = 1;
});
