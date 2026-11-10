import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents as agentsTable, heartbeatRuns, type Db } from "@paperclipai/db";
import { agentAvatarUrl, resolveAgentAppearance } from "@paperclipai/shared";
import { executionProjectionForRun, executionProjectionsForRuns } from "./execution-projection.js";
import type { heartbeatService } from "./heartbeat.js";
import type { agentService } from "./agents.js";

type HeartbeatReads = Pick<
  ReturnType<typeof heartbeatService>,
  "decorateActiveRunStatus" | "buildRunOutputSilence" | "getRunIssueSummary" | "getActiveRunIssueSummaryForAgent"
>;

export interface IssueRunPresenceIssue {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionRunId?: string | null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The run presence a task shows in its chat: queued/running runs and the active
 * run. Callers own resolving the task and authorizing the read; these builders
 * only read. Used by `/issues/:id/live-runs`, `/issues/:id/active-run` and the
 * task chat bootstrap so every path serves the same payload.
 */
export function issueRunPresenceService(
  db: Db,
  deps: {
    heartbeat: HeartbeatReads;
    getAgentById: ReturnType<typeof agentService>["getById"];
  },
) {
  const { heartbeat } = deps;

  async function liveRuns(issue: IssueRunPresenceIssue) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        runtimeMode: heartbeatRuns.runtimeMode,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        queuedCommentSourceWakeIds: sql<string[] | null>`${heartbeatRuns.contextSnapshot} -> 'queuedCommentSourceWakeIds'`.as("queuedCommentSourceWakeIds"),
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
        contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        agentAppearance: agentsTable.appearance,
        adapterType: agentsTable.adapterType,
        logBytes: heartbeatRuns.logBytes,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        lastOutputBytes: heartbeatRuns.lastOutputBytes,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          eq(heartbeatRuns.issueId, issue.id),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const projections = await executionProjectionsForRuns(db, issue.companyId, rows.map(run => run.id));
    return Promise.all(rows.map(async (run) => ({
      ...heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id }),
      agentAppearance: resolveAgentAppearance(run.agentAppearance, run.agentId),
      avatarUrl: agentAvatarUrl(resolveAgentAppearance(run.agentAppearance, run.agentId), 512),
      execution: projections.get(run.id) ?? null,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    })));
  }

  async function activeRun(issue: IssueRunPresenceIssue) {
    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) return null;

    const agent = await deps.getAgentById(run.agentId);
    if (!agent) return null;

    const decoratedRun = heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id });
    return {
      ...decoratedRun,
      execution: await executionProjectionForRun(db, issue.companyId, run.id),
      agentId: agent.id,
      agentName: agent.name,
      agentAppearance: agent.appearance,
      avatarUrl: agent.avatarUrl,
      adapterType: agent.adapterType,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    };
  }

  return { liveRuns, activeRun };
}
