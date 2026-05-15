import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { IssueComment, Issue } from "@paperclipai/shared";
import {
  evaluateTier0,
  type FixtureBlocker,
  type FixtureComment,
  type FixtureIssue,
  type Trigger,
  type Tier0Verdict,
} from "./tier0.js";

// SDK version pinned via the workspace dependency. Logged on boot so operators
// can correlate behavior with a specific SDK release.
const SDK_VERSION = "1.0.0";

function eligibleTableName(namespace: string): string {
  return `${namespace}.clarifier_eligible`;
}

function mapIssueToFixture(issue: Issue): FixtureIssue {
  return {
    id: issue.id,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt : new Date(issue.updatedAt),
  };
}

function mapCommentToFixture(comment: IssueComment): FixtureComment {
  return {
    id: comment.id,
    body: comment.body,
    actorType: comment.authorType,
    authorAgentId: comment.authorAgentId ?? null,
    createdAt: comment.createdAt instanceof Date ? comment.createdAt : new Date(comment.createdAt),
  };
}

async function loadLatestComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<FixtureComment | null> {
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (!comments.length) return null;
  const latest = comments.reduce((acc, c) => {
    const aDate = c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
    const accDate = acc.createdAt instanceof Date ? acc.createdAt : new Date(acc.createdAt);
    return aDate > accDate ? c : acc;
  });
  return mapCommentToFixture(latest);
}

async function loadBlockersDepth1(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<FixtureBlocker[]> {
  const relations = await ctx.issues.relations.get(issueId, companyId);
  return relations.blockedBy.map((b) => ({
    id: b.id,
    status: b.status,
    // Depth-1 heuristic: blocked or in_progress with no assignee = stuck.
    // The plan caps depth at 1, so we don't recurse further.
    stuck: b.status === "blocked" || (b.status === "in_progress" && !b.assigneeAgentId),
  }));
}

interface PersistInput {
  issueId: string;
  verdict: Tier0Verdict;
  triggerKind: Trigger["kind"];
  triggerEventId: string | null;
  triggerCommentId: string | null;
  issueStatus: string;
  issueAssigneeAgentId: string | null;
  details: Record<string, unknown>;
  evaluatedAt: Date;
}

async function persistVerdict(ctx: PluginContext, input: PersistInput): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${eligibleTableName(ctx.db.namespace)} (
       id,
       issue_id,
       evaluated_at,
       eligible,
       signals,
       trigger_kind,
       trigger_event_id,
       trigger_comment_id,
       issue_status,
       issue_assignee_agent_id,
       details
     ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      randomUUID(),
      input.issueId,
      input.evaluatedAt.toISOString(),
      input.verdict.eligible,
      input.verdict.signals,
      input.triggerKind,
      input.triggerEventId,
      input.triggerCommentId,
      input.issueStatus,
      input.issueAssigneeAgentId,
      JSON.stringify(input.details),
    ],
  );
}

interface EvaluateOptions {
  ctx: PluginContext;
  companyId: string;
  issueId: string;
  trigger: Trigger;
  triggerEventId: string | null;
  triggerCommentId: string | null;
  /** Last finished run timestamp tracked from `agent.run.finished`. */
  lastRunFinishedAt: Date | null;
}

async function evaluateAndPersist(opts: EvaluateOptions): Promise<Tier0Verdict | null> {
  const { ctx, companyId, issueId, trigger, triggerEventId, triggerCommentId } = opts;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) {
    ctx.logger.warn("Tier-0 skipped: issue not found", { issueId });
    return null;
  }
  const fixtureIssue = mapIssueToFixture(issue);
  const [latestComment, blockers] = await Promise.all([
    loadLatestComment(ctx, issueId, companyId),
    loadBlockersDepth1(ctx, issueId, companyId),
  ]);

  const verdict = evaluateTier0({
    issue: fixtureIssue,
    trigger,
    latestComment,
    lastRunFinishedAt: opts.lastRunFinishedAt,
    statusOrAssigneeChangedAt: fixtureIssue.updatedAt,
    blockers,
  });

  const evaluatedAt = new Date();
  await persistVerdict(ctx, {
    issueId,
    verdict,
    triggerKind: trigger.kind,
    triggerEventId,
    triggerCommentId,
    issueStatus: fixtureIssue.status,
    issueAssigneeAgentId: fixtureIssue.assigneeAgentId,
    details: { latestCommentId: latestComment?.id ?? null, blockerCount: blockers.length },
    evaluatedAt,
  });
  ctx.logger.info("Tier-0 evaluated", {
    issueId,
    eligible: verdict.eligible,
    signals: verdict.signals,
    reasons: verdict.reasons,
    triggerKind: trigger.kind,
  });
  return verdict;
}

// Per-issue cache of last finished run timestamp. In-memory is sufficient — the
// signal is "run finished in last hour", so cold-start staleness is bounded.
const lastRunFinishedByIssue = new Map<string, Date>();

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("clarifier worker ready", { sdkVersion: SDK_VERSION });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      const payload = (event.payload ?? {}) as { commentId?: string; bodySnippet?: string };
      const issueId = event.entityId ?? null;
      if (!issueId) return;
      const commentId = payload.commentId ?? null;
      // Build a synthetic trigger comment from the event envelope so the pure
      // pre-filter can fire without an extra DB round-trip when the snippet is
      // already sufficient. Full body is fetched lazily by loadLatestComment.
      const actorType =
        (event.actorType as FixtureComment["actorType"] | undefined) ?? "system";
      const triggerComment: FixtureComment = {
        id: commentId ?? randomUUID(),
        body: payload.bodySnippet ?? "",
        actorType,
        authorAgentId: actorType === "agent" ? (event.actorId ?? null) : null,
        createdAt: new Date(event.occurredAt),
      };
      await evaluateAndPersist({
        ctx,
        companyId: event.companyId,
        issueId,
        trigger: { kind: "comment.created", comment: triggerComment },
        triggerEventId: event.eventId,
        triggerCommentId: commentId,
        lastRunFinishedAt: lastRunFinishedByIssue.get(issueId) ?? null,
      });
    });

    // `issue.status_changed` is not a first-class event; derive it from
    // `issue.updated` payload diff using `_previous.status`. See CAL-109 audit
    // verdicts §2 for the agreed workaround.
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const payload = (event.payload ?? {}) as {
        patch?: Record<string, unknown>;
        _previous?: { status?: string | null };
      };
      const issueId = event.entityId ?? null;
      if (!issueId) return;
      const previousStatus = payload._previous?.status ?? null;
      const patchStatus = payload.patch && typeof payload.patch.status === "string"
        ? (payload.patch.status as string)
        : null;
      if (!patchStatus || patchStatus === previousStatus) {
        // No status transition in this update; nothing for Tier-0 to do beyond
        // the comment/run signals already wired.
        return;
      }
      await evaluateAndPersist({
        ctx,
        companyId: event.companyId,
        issueId,
        trigger: {
          kind: "issue.status_changed",
          previousStatus,
          newStatus: patchStatus,
        },
        triggerEventId: event.eventId,
        triggerCommentId: null,
        lastRunFinishedAt: lastRunFinishedByIssue.get(issueId) ?? null,
      });
    });

    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const payload = (event.payload ?? {}) as { issueId?: string | null; finishedAt?: string | null };
      const issueId = payload.issueId ?? null;
      if (!issueId) return;
      const finishedAt = payload.finishedAt ? new Date(payload.finishedAt) : new Date(event.occurredAt);
      lastRunFinishedByIssue.set(issueId, finishedAt);
      await evaluateAndPersist({
        ctx,
        companyId: event.companyId,
        issueId,
        trigger: {
          kind: "agent.run.finished",
          runId: (event.payload as { runId?: string })?.runId ?? event.eventId,
          runFinishedAt: finishedAt,
        },
        triggerEventId: event.eventId,
        triggerCommentId: null,
        lastRunFinishedAt: finishedAt,
      });
    });

    ctx.data.register("health", async () => ({
      status: "ok",
      sdkVersion: SDK_VERSION,
      databaseNamespace: ctx.db.namespace,
      checkedAt: new Date().toISOString(),
    }));

    // Manual evaluation entry point — useful for the LLM tier subtask and for
    // operator-triggered checks. Mirrors the same code path as events.
    ctx.actions.register("evaluate", async (params) => {
      const companyId = String(params.companyId ?? "");
      const issueId = String(params.issueId ?? "");
      if (!companyId || !issueId) throw new Error("companyId and issueId are required");
      const verdict = await evaluateAndPersist({
        ctx,
        companyId,
        issueId,
        trigger: { kind: "scheduled.evaluate" },
        triggerEventId: null,
        triggerCommentId: null,
        lastRunFinishedAt: lastRunFinishedByIssue.get(issueId) ?? null,
      });
      return verdict ?? { eligible: false, signals: [], reasons: ["no_signal"] };
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Clarifier worker is running",
      details: { sdkVersion: SDK_VERSION, trackedIssues: lastRunFinishedByIssue.size },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
