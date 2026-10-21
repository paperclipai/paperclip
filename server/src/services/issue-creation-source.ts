import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

type IssueRow = typeof issues.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

/** The task a run was executing when it created another task. */
export interface IssueCreationSourceRecord {
  run: HeartbeatRunRow;
  sourceIssue: IssueRow;
}

const CREATION_ACTIVITY_ACTIONS = ["issue.created", "issue.child_created"];

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The issue a heartbeat run is bound to: native run identity first, then the
 * run's issue scope, then the persisted legacy task context. Returns a UUID or
 * an issue identifier such as `PAP-168`; the caller resolves identifiers.
 */
export function runBoundIssueReference(run: Pick<HeartbeatRunRow, "nativeIssueId" | "issueId" | "contextSnapshot">): string | null {
  const context = run.contextSnapshot && typeof run.contextSnapshot === "object"
    ? (run.contextSnapshot as Record<string, unknown>)
    : null;
  const paperclipIssue = context?.paperclipIssue && typeof context.paperclipIssue === "object"
    ? (context.paperclipIssue as Record<string, unknown>)
    : null;
  return (
    run.nativeIssueId ??
    run.issueId ??
    readNonEmptyString(context?.issueId) ??
    readNonEmptyString(context?.taskId) ??
    readNonEmptyString(paperclipIssue?.id) ??
    readNonEmptyString(context?.taskKey)
  );
}

/** Loads the run's bound issue within the run's company, or null. */
export async function loadRunBoundIssue(
  db: Db,
  run: Pick<HeartbeatRunRow, "companyId" | "nativeIssueId" | "issueId" | "contextSnapshot">,
): Promise<IssueRow | null> {
  const reference = runBoundIssueReference(run);
  if (!reference) return null;
  const condition = isUuidLike(reference)
    ? eq(issues.id, reference)
    : eq(issues.identifier, reference);
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(condition, eq(issues.companyId, run.companyId)))
    .limit(1);
  return issue ?? null;
}

/**
 * Resolves the task from which an issue was created, using recorded run
 * provenance: the issue's origin run, or for historical rows without one, the
 * run on its creation activity. Company-scoped; a run or source task from
 * another company never resolves. Does not check viewer access.
 */
export async function resolveIssueCreationSource(
  db: Db,
  issue: Pick<IssueRow, "id" | "companyId" | "originRunId">,
): Promise<IssueCreationSourceRecord | null> {
  let runId = issue.originRunId;
  if (!runId) {
    const [creation] = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        inArray(activityLog.action, CREATION_ACTIVITY_ACTIONS),
        isNotNull(activityLog.runId),
      ))
      .orderBy(asc(activityLog.createdAt))
      .limit(1);
    runId = creation?.runId ?? null;
  }
  if (!runId || !isUuidLike(runId)) return null;
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId)))
    .limit(1);
  if (!run) return null;
  const sourceIssue = await loadRunBoundIssue(db, run);
  if (!sourceIssue || sourceIssue.id === issue.id) return null;
  return { run, sourceIssue };
}

/** Company-scoped agent summary for a creation source. */
export async function loadCreationSourceAgent(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string; name: string } | null> {
  const [agent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  return agent ?? null;
}
