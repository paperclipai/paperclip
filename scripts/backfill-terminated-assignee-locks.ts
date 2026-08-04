import { and, eq, inArray, isNotNull, isNull, or, agents, companies, createDb, issueComments, issues } from "../packages/db/src/index.js";
import { isAgentStatusAssignableToWork } from "../packages/shared/src/agent-eligibility.js";
import { loadConfig } from "../server/src/config.js";

const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const companyId = parseFlag("--company");
  const dryRun = process.argv.includes("--dry-run");
  const db = createDb(dbUrl);
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  let beforeCount = 0;
  let releasedToManager = 0;
  let releasedToQueue = 0;

  for (const company of companyRows) {
    const candidates = await db
      .select({
        issueId: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeStatus: agents.status,
        managerId: agents.reportsTo,
      })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(
        and(
          eq(issues.companyId, company.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNotNull(issues.assigneeAgentId),
          or(eq(agents.status, "terminated"), isNull(agents.id)),
        ),
      );

    beforeCount += candidates.length;
    for (const candidate of candidates) {
      const manager = candidate.managerId
        ? await db
          .select({ id: agents.id, status: agents.status })
          .from(agents)
          .where(and(eq(agents.id, candidate.managerId), eq(agents.companyId, company.id)))
          .then((rows) => rows[0] ?? null)
        : null;
      const assigneeAgentId = manager && isAgentStatusAssignableToWork(manager.status) ? manager.id : null;
      if (assigneeAgentId) releasedToManager += 1;
      else releasedToQueue += 1;

      if (dryRun) continue;
      await db.transaction(async (tx) => {
        await tx
          .update(issues)
          .set({ assigneeAgentId, updatedAt: new Date() })
          .where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, company.id)));
        await tx.insert(issueComments).values({
          companyId: company.id,
          issueId: candidate.issueId,
          authorType: "system",
          body: assigneeAgentId
            ? `System backfill: released an assignment from source agent ${candidate.assigneeAgentId}; reason: ${candidate.assigneeStatus === "terminated" ? "agent was terminated" : "source agent is missing"}; reassigned to its manager.`
            : `System backfill: released an assignment from source agent ${candidate.assigneeAgentId}; reason: ${candidate.assigneeStatus === "terminated" ? "agent was terminated" : "source agent is missing"}; moved to the unassigned queue.`,
        });
      });
    }
  }

  let afterCount = beforeCount;
  if (!dryRun) {
    afterCount = 0;
    for (const company of companyRows) {
      const remainingCandidates = await db
        .select({ issueId: issues.id })
        .from(issues)
        .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.companyId, company.id),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNotNull(issues.assigneeAgentId),
            or(eq(agents.status, "terminated"), isNull(agents.id)),
          ),
        );
      afterCount += remainingCandidates.length;
    }
  }

  console.log(`${dryRun ? "Dry run: " : ""}terminated-assignee backfill counts`);
  console.log(`before=${beforeCount}`);
  console.log(`released_to_manager=${releasedToManager}`);
  console.log(`released_to_unassigned_queue=${releasedToQueue}`);
  console.log(`after=${afterCount}`);
  await db.$client.end({ timeout: 1 });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Terminated-assignee backfill failed: ${message}`);
  process.exitCode = 1;
});
