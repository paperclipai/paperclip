/**
 * Log event handlers — structured log emission.
 *
 * Each handler emits structured log entries via the plugin logger in response
 * to Paperclip domain events. These logs complement metrics and traces by
 * providing human-readable context for debugging and audit trails.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";

// ---------------------------------------------------------------------------
// agent.run.started — info log
// ---------------------------------------------------------------------------

export async function handleRunStartedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Agent run started", {
    runId: String(p.runId ?? ""),
    agentId: String(p.agentId ?? ""),
    agentName: String(p.agentName ?? ""),
    invocationSource: String(p.invocationSource ?? ""),
    triggerDetail: String(p.triggerDetail ?? ""),
    companyId: String(p.companyId ?? ""),
  });
}

// ---------------------------------------------------------------------------
// agent.run.finished — info log
// ---------------------------------------------------------------------------

export async function handleRunFinishedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Agent run finished", {
    runId: String(p.runId ?? ""),
    agentId: String(p.agentId ?? ""),
    durationMs: p.durationMs != null ? Number(p.durationMs) : undefined,
    exitCode: p.exitCode != null ? Number(p.exitCode) : undefined,
  });
}

// ---------------------------------------------------------------------------
// agent.run.failed — error log
// ---------------------------------------------------------------------------

export async function handleRunFailedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.error("Agent run failed", {
    runId: String(p.runId ?? ""),
    agentId: String(p.agentId ?? ""),
    error: String(p.error ?? "unknown"),
    errorCode: String(p.errorCode ?? ""),
    exitCode: p.exitCode != null ? Number(p.exitCode) : undefined,
  });
}

// ---------------------------------------------------------------------------
// agent.status_changed — warn/info log
// ---------------------------------------------------------------------------

export async function handleAgentStatusChangedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = String(p.status ?? "unknown");

  const logFn = status === "paused" ? ctx.logger.warn : ctx.logger.info;
  logFn.call(ctx.logger, "Agent status changed", {
    agentId: String(p.agentId ?? ""),
    status,
    previousStatus: String(p.previousStatus ?? ""),
    pauseReason: p.pauseReason ? String(p.pauseReason) : undefined,
  });
}

// ---------------------------------------------------------------------------
// issue.created — info log
// ---------------------------------------------------------------------------

export async function handleIssueCreatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Issue created", {
    issueId: String(p.id ?? ""),
    identifier: String(p.identifier ?? ""),
    title: String(p.title ?? ""),
    projectId: String(p.projectId ?? ""),
    priority: String(p.priority ?? "medium"),
  });
}

// ---------------------------------------------------------------------------
// issue.updated — info log for transitions
// ---------------------------------------------------------------------------

export async function handleIssueUpdatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Issue updated", {
    issueId: String(p.id ?? ""),
    identifier: String(p.identifier ?? ""),
    status: String(p.status ?? "unknown"),
    previousStatus: String(p.previousStatus ?? ""),
    projectId: String(p.projectId ?? ""),
  });
}

// ---------------------------------------------------------------------------
// approval.created — info log
// ---------------------------------------------------------------------------

export async function handleApprovalCreatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Approval created", {
    approvalId: String(p.id ?? ""),
    companyId: String(p.companyId ?? ""),
  });
}

// ---------------------------------------------------------------------------
// approval.decided — info log
// ---------------------------------------------------------------------------

export async function handleApprovalDecidedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  ctx.logger.info("Approval decided", {
    approvalId: String(p.id ?? ""),
    decision: String(p.decision ?? "unknown"),
    companyId: String(p.companyId ?? ""),
  });
}
