import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

export type IssueCheckpointKind = "takeover" | "park";

const NON_TERMINAL_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

function digestClip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Redact obvious secret-shaped tokens from free-text handoff digests.
 * Never paste transcripts or env dumps into checkpoint comments.
 */
function redactDigestText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+\b/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|api|key|token|secret)[-_A-Za-z0-9]{8,}\b/gi, "[redacted-secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._\-]+\b/g, "[redacted-jwt]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted-hash]");
}

function headingFor(kind: IssueCheckpointKind, at: Date): string {
  if (kind === "park") {
    return `## Park checkpoint (auto-generated, ${at.toISOString()})`;
  }
  return `## Takeover checkpoint (auto-generated, ${at.toISOString()})`;
}

export interface PostIssueCheckpointDigestInput {
  companyId: string;
  issueId: string;
  /** Prefer the previous assignee when known (takeover/from-agent). */
  agentId?: string | null;
  kind: IssueCheckpointKind;
  runId?: string | null;
  /** Extra one-line context (pause reason, sister name, etc.). */
  contextLine?: string | null;
  now?: Date;
}

/**
 * Compact handoff checkpoint (TSMC-20213).
 * Cap roughly ~2k tokens: summary + next action + status/blockers + resume pointer.
 * Best-effort: callers must never fail the parent mutation because the digest failed.
 */
export async function postIssueCheckpointDigest(
  db: Db,
  input: PostIssueCheckpointDigestInput,
): Promise<{ posted: boolean; bodyLength: number }> {
  const now = input.now ?? new Date();
  const svc = issueService(db);

  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      title: issues.title,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return { posted: false, bodyLength: 0 };

  const agentFilter = input.agentId
    ? eq(heartbeatRuns.agentId, input.agentId)
    : sql`true`;

  const [lastGoodRun] = await db
    .select({
      id: heartbeatRuns.id,
      resultJson: heartbeatRuns.resultJson,
      nextAction: heartbeatRuns.nextAction,
      finishedAt: heartbeatRuns.finishedAt,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.status, "succeeded"),
        agentFilter,
        sql`(
          ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}
          or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}
        )`,
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1);

  const lastResult =
    typeof lastGoodRun?.resultJson === "object" && lastGoodRun?.resultJson !== null
      ? (lastGoodRun.resultJson as Record<string, unknown>)
      : {};
  const lastSummary = [lastResult.summary, lastResult.result, lastResult.message].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const lastNextAction =
    typeof lastGoodRun?.nextAction === "string" && lastGoodRun.nextAction.trim().length > 0
      ? lastGoodRun.nextAction.trim()
      : typeof lastResult.nextAction === "string" && lastResult.nextAction.trim().length > 0
        ? lastResult.nextAction.trim()
        : null;

  const openBlockers = await db
    .select({ identifier: issues.identifier, title: issues.title, status: issues.status })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .where(
      and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.relatedIssueId, issue.id),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(8);

  const hasPayload = Boolean(lastSummary || lastNextAction || openBlockers.length || issue.status);
  if (!hasPayload) return { posted: false, bodyLength: 0 };

  const lines = [
    headingFor(input.kind, now),
    "",
    `Issue: ${issue.identifier ?? issue.id} · status \`${issue.status}\``,
    ...(input.contextLine ? [input.contextLine] : []),
    ...(lastGoodRun?.finishedAt
      ? [
          `Last successful run${input.agentId ? " for previous assignee" : ""}: ${lastGoodRun.finishedAt.toISOString()} (\`${lastGoodRun.id}\`)`,
        ]
      : ["No successful issue-scoped run found for the previous assignee."]),
    ...(lastSummary
      ? ["", "**Last successful run summary:**", redactDigestText(digestClip(lastSummary.trim(), 1200))]
      : []),
    ...(lastNextAction
      ? ["", `**Recorded next action:** ${redactDigestText(digestClip(lastNextAction, 400))}`]
      : []),
    ...(openBlockers.length
      ? [
          "",
          `**Open blockers:** ${openBlockers
            .map((b) => `${b.identifier ?? "?"} (\`${b.status}\`)`)
            .join(", ")}`,
        ]
      : ["", "**Open blockers:** none"]),
    "",
    "**Resume from here.** Do not re-derive prior work or re-read the full thread — use the",
    "issue description acceptance section, this checkpoint, and any comment newer than it,",
    "then continue. Do not paste secrets or transcripts into follow-up comments.",
  ];

  const body = lines.join("\n");
  // Soft cap ~2k tokens ≈ 8k chars of English prose.
  const capped = body.length > 8000 ? `${body.slice(0, 8000)}…` : body;

  await svc.addComment(
    issue.id,
    capped,
    { runId: input.runId ?? null },
    { authorType: "system" },
  );
  return { posted: true, bodyLength: capped.length };
}

/**
 * When a lane is paused mid-flight (quota/limit/manual/budget), stamp each of its
 * non-terminal assigned issues with the same digest shape so ANY future lane resumes warm.
 */
export async function postParkCheckpointsForAgent(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    pauseReason?: string | null;
    runId?: string | null;
    now?: Date;
    maxIssues?: number;
  },
): Promise<{ issuesConsidered: number; posted: number }> {
  const maxIssues = Math.max(1, input.maxIssues ?? 40);
  const assigned = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.agentId),
        notInArray(issues.status, ["done", "cancelled"]),
        isNull(issues.hiddenAt),
      ),
    )
    .limit(maxIssues);

  let posted = 0;
  const contextLine = input.pauseReason
    ? `Lane parked (\`${input.pauseReason}\`). Future assignees should resume from this checkpoint.`
    : "Lane parked. Future assignees should resume from this checkpoint.";

  for (const issue of assigned) {
    // Prefer active execution states; still stamp todo/blocked so cold resumes stay warm.
    if (
      !NON_TERMINAL_ISSUE_STATUSES.includes(
        issue.status as (typeof NON_TERMINAL_ISSUE_STATUSES)[number],
      )
    ) {
      continue;
    }
    try {
      const result = await postIssueCheckpointDigest(db, {
        companyId: input.companyId,
        issueId: issue.id,
        agentId: input.agentId,
        kind: "park",
        runId: input.runId ?? null,
        contextLine,
        now: input.now,
      });
      if (result.posted) posted += 1;
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id, agentId: input.agentId },
        "park checkpoint digest failed (pause unaffected)",
      );
    }
  }

  if (posted > 0) {
    logger.info(
      { agentId: input.agentId, posted, issuesConsidered: assigned.length },
      "posted park checkpoints for paused agent",
    );
  }
  return { issuesConsidered: assigned.length, posted };
}
