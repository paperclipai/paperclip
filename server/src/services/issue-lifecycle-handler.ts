/**
 * IssueLifecycleTerminated v1 — integration event handler.
 *
 * Published by the Issue context when an Issue transitions to a terminal state
 * (done | cancelled). Consumed by the ExecutionWorkspace context to stop managed
 * runtime services when no other live issue retains the workspace.
 *
 * Design: COD-193 ADR  https://paperclip.app/COD/issues/COD-193#document-plan
 */

import { randomUUID } from "node:crypto";
import { and, eq, not, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { publishPluginDomainEvent } from "./activity-log.js";
import { issueService } from "./issues.js";
import { stopRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Event payload type (v1)
// ---------------------------------------------------------------------------

export interface IssueLifecycleTerminatedPayload {
  issueId: string;
  terminalStatus: "done" | "cancelled";
  /** ISO-8601 timestamp of the transition. */
  closedAt: string;
  /** Null when the issue had no linked execution workspace at close time. */
  executionWorkspaceId: string | null;
}

// ---------------------------------------------------------------------------
// Internal subscription ID (stable; never unregistered)
// ---------------------------------------------------------------------------

const SYSTEM_SUBSCRIBER_ID = "system.workspace-lifecycle";
const TERMINAL_STATUSES = ["done", "cancelled"] as const;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Emission helper (called from the issue PATCH route)
// ---------------------------------------------------------------------------

export function emitIssueLifecycleTerminated(issue: {
  id: string;
  companyId: string;
  status: "done" | "cancelled";
  completedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  executionWorkspaceId?: string | null;
}): void {
  const closedAt = (issue.status === "done" ? issue.completedAt : issue.cancelledAt)
    ?? new Date();

  const event: PluginEvent<IssueLifecycleTerminatedPayload> = {
    eventId: randomUUID(),
    eventType: "issue.lifecycle.terminated",
    occurredAt: new Date().toISOString(),
    actorType: "system",
    actorId: "issue-lifecycle",
    entityId: issue.id,
    entityType: "issue",
    companyId: issue.companyId,
    payload: {
      issueId: issue.id,
      terminalStatus: issue.status,
      closedAt: closedAt instanceof Date ? closedAt.toISOString() : String(closedAt),
      executionWorkspaceId: issue.executionWorkspaceId ?? null,
    },
  };

  publishPluginDomainEvent(event);
}

// ---------------------------------------------------------------------------
// Internal handler
// ---------------------------------------------------------------------------

async function handleWithRetry(
  fn: () => Promise<void>,
  label: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn({ err, attempt, delayMs, label }, "issue-lifecycle-handler: retrying after error");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function handleIssueLifecycleTerminated(
  db: Db,
  event: PluginEvent,
): Promise<void> {
  const payload = event.payload as IssueLifecycleTerminatedPayload;
  const { issueId, executionWorkspaceId } = payload;

  // No workspace on this issue — nothing to tear down.
  if (!executionWorkspaceId) return;

  // Find the workspace row to get its cwd.
  const workspace = await db
    .select({
      id: executionWorkspaces.id,
      status: executionWorkspaces.status,
      cwd: executionWorkspaces.cwd,
    })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, executionWorkspaceId))
    .then((rows) => rows[0] ?? null);

  if (!workspace) {
    logger.debug({ issueId, executionWorkspaceId }, "issue-lifecycle-handler: workspace not found, skipping");
    return;
  }

  // Idempotency gate: already torn down.
  if (workspace.status === "archived" || workspace.status === "cleanup_failed") {
    logger.debug({ issueId, executionWorkspaceId, status: workspace.status }, "issue-lifecycle-handler: workspace already terminal, no-op");
    return;
  }

  // Surviving non-terminal owners check.
  // If any issue other than the one being closed still holds this workspace in
  // a live state, leave the services running.
  const liveOwners = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.executionWorkspaceId, executionWorkspaceId),
        not(inArray(issues.status, [...TERMINAL_STATUSES])),
        not(eq(issues.id, issueId)),
      ),
    );

  if (liveOwners.length > 0) {
    logger.info(
      { issueId, executionWorkspaceId, liveOwnerCount: liveOwners.length },
      "issue-lifecycle-handler: workspace retained by live issues, skipping stop",
    );
    return;
  }

  // Stop runtime services (with retries and failure comment).
  try {
    await handleWithRetry(async () => {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspace.cwd,
      });
    }, `stop workspace ${executionWorkspaceId} for issue ${issueId}`);

    logger.info({ issueId, executionWorkspaceId }, "issue-lifecycle-handler: runtime services stopped");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, issueId, executionWorkspaceId }, "issue-lifecycle-handler: teardown failed after retries");

    // Post a failure comment on the closing issue so it is visible in the thread.
    const instanceOpsAgentId = "f2906b46-1c6d-4ea6-a3b3-cfddc394a304";
    const commentBody = [
      `⚠️ **Workspace teardown failed** for execution workspace \`${executionWorkspaceId}\`.`,
      "",
      `Error: ${errMsg}`,
      "",
      `[@InstanceOps](agent://${instanceOpsAgentId}) please investigate and stop services manually.`,
    ].join("\n");

    try {
      await issueService(db).addComment(issueId, commentBody, {
        agentId: undefined,
        userId: undefined,
        runId: null,
      });
    } catch (commentErr) {
      logger.error({ commentErr, issueId }, "issue-lifecycle-handler: failed to post teardown failure comment");
    }
  }
}

// ---------------------------------------------------------------------------
// Registration (called once from app.ts after event bus is wired)
// ---------------------------------------------------------------------------

export function registerIssueLifecycleHandler(db: Db, eventBus: PluginEventBus): void {
  const scopedBus = eventBus.forPlugin(SYSTEM_SUBSCRIBER_ID);
  scopedBus.subscribe("issue.lifecycle.terminated", async (event) => {
    await handleIssueLifecycleTerminated(db, event);
  });
  logger.info("issue-lifecycle-handler: subscribed to issue.lifecycle.terminated");
}
