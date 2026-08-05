import { and, eq, inArray, isNotNull, isNull, or, sql, agents, companies, createDb, issueComments, issues } from "../packages/db/src/index.js";
import { isAgentAssignableToWork } from "../packages/shared/src/agent-eligibility.js";
import { loadConfig } from "../server/src/config.js";

const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const companyId = parseFlag("--company");
  const dryRun = process.argv.includes("--dry-run");
  const db = createDb(dbUrl);
  const companyRows = companyId ? [{ id: companyId }] : await db.select({ id: companies.id }).from(companies);

  let beforeCount = 0;
  let releasedToManager = 0;
  let releasedToQueue = 0;

  for (const company of companyRows) {
    const companyAgents = await db.select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    }).from(agents).where(eq(agents.companyId, company.id));
    const candidates = await db.select({
      issueId: issues.id,
      assigneeAgentId: issues.assigneeAgentId,
      managerId: agents.reportsTo,
    }).from(issues).leftJoin(agents, eq(issues.assigneeAgentId, agents.id)).where(and(
      eq(issues.companyId, company.id),
      inArray(issues.status, OPEN_ISSUE_STATUSES),
      isNotNull(issues.assigneeAgentId),
      or(eq(agents.status, "terminated"), isNull(agents.id)),
    ));

    beforeCount += candidates.length;
    for (const candidate of candidates) {
      const manager = candidate.managerId
        ? companyAgents.find((agent) => agent.id === candidate.managerId) ?? null
        : null;
      const assigneeAgentId = manager && isAgentAssignableToWork({ agent: manager, agents: companyAgents }) ? manager.id : null;
      if (dryRun) {
        if (assigneeAgentId) releasedToManager += 1;
        else releasedToQueue += 1;
        continue;
      }

      await db.transaction(async (tx) => {
        // Serialize against terminate() before reading the graph. Re-reading
        // without locks still permits a manager termination to commit between
        // this check and the issue assignment below.
        await tx.execute(
          sql`select ${agents.id} from ${agents} where ${agents.companyId} = ${company.id} order by ${agents.id} for update`,
        );
        const currentAgents = await tx.select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          reportsTo: agents.reportsTo,
        }).from(agents).where(eq(agents.companyId, company.id));
        const source = currentAgents.find((agent) => agent.id === candidate.assigneeAgentId) ?? null;
        if (source && source.status !== "terminated") return;
        const releaseReason = source ? "agent was terminated" : "source agent is missing";
        const currentManager = source?.reportsTo
          ? currentAgents.find((agent) => agent.id === source.reportsTo) ?? null
          : null;
        const currentAssigneeAgentId = currentManager && isAgentAssignableToWork({
          agent: currentManager,
          agents: currentAgents,
        })
          ? currentManager.id
          : null;
        const released = await tx.update(issues).set({ assigneeAgentId: currentAssigneeAgentId, updatedAt: new Date() })
          .where(and(
            eq(issues.id, candidate.issueId),
            eq(issues.companyId, company.id),
            eq(issues.assigneeAgentId, candidate.assigneeAgentId!),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
          ))
          .returning({ id: issues.id });
        if (released.length === 0) return;
        await tx.insert(issueComments).values({
          companyId: company.id,
          issueId: candidate.issueId,
          authorType: "system",
          body: currentAssigneeAgentId
            ? `System backfill: released an assignment from source agent ${candidate.assigneeAgentId}; reason: ${releaseReason}; reassigned to its manager.`
            : `System backfill: released an assignment from source agent ${candidate.assigneeAgentId}; reason: ${releaseReason}; moved to the unassigned queue.`,
        });
        if (currentAssigneeAgentId) releasedToManager += 1;
        else releasedToQueue += 1;
      });
    }
  }

  let afterCount = beforeCount;
  if (!dryRun) {
    afterCount = 0;
    for (const company of companyRows) {
      const remaining = await db.select({ issueId: issues.id }).from(issues)
        .leftJoin(agents, eq(issues.assigneeAgentId, agents.id)).where(and(
          eq(issues.companyId, company.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNotNull(issues.assigneeAgentId),
          or(eq(agents.status, "terminated"), isNull(agents.id)),
        ));
      afterCount += remaining.length;
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
  console.error(`Terminated-assignee backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
