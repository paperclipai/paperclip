import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents } from "@paperclipai/db";
import type { HireApprovedPayload } from "@paperclipai/adapter-utils";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Paperclip or ask you to create issues.";

const HIRE_KICKOFF_ORIGIN_KIND = "hire_kickoff";
const HIRE_KICKOFF_TITLE = "Onboarding: introduce yourself and share your first 30/60/90 plan";
type HireKickoffIssue = { id: string; assigneeAgentId: string | null; status: string };

function buildHireKickoffBody(agentName: string) {
  return [
    `Welcome ${agentName}. This kickoff issue was created automatically when your hire was approved.`,
    "",
    "Checklist:",
    "- Read your AGENTS.md and any role-specific instructions.",
    "- Read VISION.md or the company constitution/docs if they are available.",
    "- Identify your reporting line or manager and post a short hello.",
    "- Post your first 30/60/90 plan as a comment on this issue.",
    "- Do not close this issue until your manager or the board approves your plan.",
  ].join("\n");
}

async function logHireHookActivitySafely(
  db: Db,
  input: Parameters<typeof logActivity>[1],
) {
  try {
    await logActivity(db, input);
  } catch (err) {
    logger.warn({ err, action: input.action, entityId: input.entityId }, "hire hook: failed to write activity log");
  }
}

async function ensureHireKickoffIssue(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    agentName: string;
    source: NotifyHireApprovedInput["source"];
    sourceId: string;
  },
) {
  const issuesSvc = issueService(db);
  const existing = await issuesSvc.list(input.companyId, {
    originKind: HIRE_KICKOFF_ORIGIN_KIND,
    originId: input.agentId,
    limit: 1,
  });
  const existingIssue = existing[0];
  if (existingIssue) {
    return { issue: existingIssue, created: false };
  }

  const issue = await issuesSvc.create(input.companyId, {
    title: HIRE_KICKOFF_TITLE,
    description: buildHireKickoffBody(input.agentName),
    status: "todo",
    priority: "high",
    assigneeAgentId: input.agentId,
    createdByAgentId: null,
    createdByUserId: null,
    originKind: HIRE_KICKOFF_ORIGIN_KIND,
    originId: input.agentId,
    originFingerprint: `${input.source}:${input.sourceId}`,
  });

  return { issue, created: true };
}

function isWakeableKickoffIssue(issue: HireKickoffIssue) {
  return Boolean(issue.assigneeAgentId) && !["backlog", "done", "cancelled"].includes(issue.status);
}

async function hasHireKickoffWakeupRequest(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
  },
) {
  const existing = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.source, "assignment"),
        eq(agentWakeupRequests.requestedByActorType, "system"),
        eq(agentWakeupRequests.requestedByActorId, "hire_hook"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(1);
  return existing.length > 0;
}

async function shouldQueueHireKickoffWakeup(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issue: HireKickoffIssue;
    created: boolean;
  },
) {
  if (!isWakeableKickoffIssue(input.issue)) return false;
  if (input.created) return true;
  try {
    return !(await hasHireKickoffWakeupRequest(db, {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issue.id,
    }));
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, issueId: input.issue.id },
      "hire hook: failed to check existing kickoff wakeup request",
    );
    return true;
  }
}

async function queueHireKickoffWakeupSafely(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issue: HireKickoffIssue;
    source: NotifyHireApprovedInput["source"];
    sourceId: string;
  },
) {
  try {
    await queueIssueAssignmentWakeup({
      heartbeat: heartbeatService(db),
      issue: input.issue,
      reason: "hire_kickoff",
      mutation: "hire_approved",
      contextSource: "hire_hook",
      requestedByActorType: "system",
      requestedByActorId: "hire_hook",
      rethrowOnError: true,
    });
  } catch (err) {
    logger.error(
      {
        err,
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issue.id,
        source: input.source,
        sourceId: input.sourceId,
      },
      "hire hook: failed to queue kickoff wakeup",
    );
    await logHireHookActivitySafely(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_kickoff.wakeup_failed",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: input.source,
        sourceId: input.sourceId,
        agentId: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export interface NotifyHireApprovedInput {
  companyId: string;
  agentId: string;
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt?: Date;
  /** When false, create/wake the kickoff issue before returning, then dispatch the adapter hook in the background. */
  awaitAdapterHook?: boolean;
}

/**
 * Invokes the adapter's onHireApproved hook when an agent is approved (join-request or hire_agent approval).
 * Failures are non-fatal: we log and write to activity, never throw.
 */
export async function notifyHireApproved(
  db: Db,
  input: NotifyHireApprovedInput,
): Promise<void> {
  const { companyId, agentId, source, sourceId } = input;
  const approvedAt = input.approvedAt ?? new Date();

  let row: typeof agents.$inferSelect | null = null;
  try {
    row = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  } catch (err) {
    logger.error(
      { err, companyId, agentId, source, sourceId },
      "hire hook: failed to load approved agent",
    );
    await logHireHookActivitySafely(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.error",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  if (!row) {
    logger.warn({ companyId, agentId, source, sourceId }, "hire hook: agent not found in company, skipping");
    return;
  }

  let kickoff: { issue: HireKickoffIssue; created: boolean } | null = null;
  try {
    kickoff = await ensureHireKickoffIssue(db, {
      companyId,
      agentId,
      agentName: row.name,
      source,
      sourceId,
    });
    if (kickoff.created) {
      await logHireHookActivitySafely(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_kickoff.created",
        entityType: "issue",
        entityId: kickoff.issue.id,
        details: { source, sourceId, agentId },
      });
    }
  } catch (err) {
    logger.error(
      { err, companyId, agentId, source, sourceId },
      "hire hook: failed to create kickoff issue",
    );
    await logHireHookActivitySafely(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_kickoff.failed",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  if (kickoff && await shouldQueueHireKickoffWakeup(db, {
    companyId,
    agentId,
    issue: kickoff.issue,
    created: kickoff.created,
  })) {
    await queueHireKickoffWakeupSafely(db, {
      companyId,
      agentId,
      issue: kickoff.issue,
      source,
      sourceId,
    });
  }

  const dispatchAdapterHook = async () => {
    await dispatchHireApprovedAdapterHook(db, {
      ...input,
      approvedAt,
    }, row);
  };
  if (input.awaitAdapterHook === false) {
    void dispatchAdapterHook().catch((err) => {
      logger.error(
        { err, companyId, agentId, source, sourceId },
        "hire hook: background adapter dispatch failed",
      );
    });
    return;
  }

  await dispatchAdapterHook();
}

async function dispatchHireApprovedAdapterHook(
  db: Db,
  input: NotifyHireApprovedInput & { approvedAt: Date },
  row: typeof agents.$inferSelect,
) {
  const { companyId, agentId, source, sourceId, approvedAt } = input;
  const adapterType = row.adapterType ?? "process";
  const adapter = findActiveServerAdapter(adapterType);
  const onHireApproved = adapter?.onHireApproved;
  if (!onHireApproved) {
    return;
  }

  const payload: HireApprovedPayload = {
    companyId,
    agentId,
    agentName: row.name,
    adapterType,
    source,
    sourceId,
    approvedAt: approvedAt.toISOString(),
    message: HIRE_APPROVED_MESSAGE,
  };

  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? (row.adapterConfig as Record<string, unknown>)
      : {};

  try {
    const result = await onHireApproved(payload, adapterConfig);
    if (result.ok) {
      await logHireHookActivitySafely(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.succeeded",
        entityType: "agent",
        entityId: agentId,
        details: { source, sourceId, adapterType },
      });
      return;
    }

    logger.warn(
      { companyId, agentId, adapterType, source, sourceId, error: result.error, detail: result.detail },
      "hire hook: adapter returned failure",
    );
    await logHireHookActivitySafely(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.failed",
      entityType: "agent",
      entityId: agentId,
      details: { source, sourceId, adapterType, error: result.error, detail: result.detail },
    });
  } catch (err) {
    logger.error(
      { err, companyId, agentId, adapterType, source, sourceId },
      "hire hook: adapter threw",
    );
    await logHireHookActivitySafely(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.error",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        adapterType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
