import type { HeartbeatRun } from "@paperclipai/shared";
import type { IssueForRun } from "../api/activity";

export type RunNarrative = {
  why: string;
  work: string;
  outcome: string;
  session: string;
  compact: string;
};

export type RunDiagnosticTone = "info" | "success" | "warn" | "error";

export type RunDiagnostic = {
  tone: RunDiagnosticTone;
  text: string;
};

type RunContext = Record<string, unknown> | null;

const QUOTA_OR_RATE_LIMIT_RE =
  /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details|you['’]ve hit your limit|hit your limit|limit[^.\n]*reset)/i;
const TOOL_RUNTIME_FAILURE_RE =
  /(?:CreateProcess .*No such file or directory|Failed to create unified exec process|exec_command failed|write_stdin failed: stdin is closed|rerun exec_command with tty=true to keep stdin open)/i;
const LOG_TIMEOUT_CONFIG_RE = /\btimeout=\d+s\b/i;
const LOG_TIMED_OUT_FALSE_RE = /\btimed out:\s*false\b/i;

const WAKE_REASON_LABELS: Record<string, string> = {
  heartbeat_timer: "its scheduled heartbeat fired",
  issue_assigned: "a new issue was assigned",
  issue_status_changed: "an issue changed state",
  issue_comment_mentioned: "someone mentioned this agent on an issue",
  issue_checked_out: "an issue was checked out",
  issue_reopened_via_comment: "an issue was reopened from comments",
  issue_commented: "a new issue comment came in",
  approval_approved: "an approval was resolved",
  process_lost_retry: "Paperclip retried after the previous process disappeared",
  resume_process_lost_run: "an operator resumed a lost run",
  retry_failed_run: "an operator retried a failed run",
  managed_issue_resolved: "automation resolved a tracked issue",
  routine_health_alert: "automation detected a routine health alert",
  "agent.run.failed": "another agent failed and triggered follow-through",
  "issue.created": "a new issue event came in",
  "issue.updated": "an issue update came in",
  "routine.run_triggered": "a routine trigger fired",
};

const WAKE_REASON_SHORT_LABELS: Record<string, string> = {
  heartbeat_timer: "scheduled heartbeat",
  issue_assigned: "new issue assigned",
  issue_status_changed: "issue changed",
  issue_comment_mentioned: "mentioned on issue",
  issue_checked_out: "issue checked out",
  issue_reopened_via_comment: "issue reopened",
  issue_commented: "new issue comment",
  approval_approved: "approval resolved",
  process_lost_retry: "retry after lost process",
  resume_process_lost_run: "resumed lost run",
  retry_failed_run: "retry after failure",
  managed_issue_resolved: "automation follow-through",
  routine_health_alert: "routine health alert",
  "agent.run.failed": "agent failure follow-through",
  "issue.created": "new issue event",
  "issue.updated": "issue update event",
  "routine.run_triggered": "routine triggered",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function humanizeKey(value: string): string {
  return value.replace(/[._-]+/g, " ").trim();
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatIssueLabel(issue: Pick<IssueForRun, "identifier" | "title">): string {
  return issue.identifier?.trim() || issue.title.trim();
}

function readRunContext(run: HeartbeatRun): RunContext {
  return asRecord(run.contextSnapshot);
}

export function describeRunReason(run: HeartbeatRun): string {
  const context = readRunContext(run);
  const wakeReason = asNonEmptyString(context?.wakeReason);
  if (wakeReason) {
    return WAKE_REASON_LABELS[wakeReason] ?? humanizeKey(wakeReason);
  }

  switch (run.invocationSource) {
    case "timer":
      return "its scheduled heartbeat fired";
    case "assignment":
      return "it was woken for assigned work";
    case "automation":
      return "automation woke it";
    case "on_demand":
      return run.triggerDetail === "manual" ? "someone ran it on demand" : "it was started on demand";
    default:
      return "Paperclip started it";
  }
}

export function buildRunReasonLabel(run: HeartbeatRun): string {
  const context = readRunContext(run);
  const wakeReason = asNonEmptyString(context?.wakeReason);
  if (wakeReason) {
    return WAKE_REASON_SHORT_LABELS[wakeReason] ?? humanizeKey(wakeReason);
  }

  switch (run.invocationSource) {
    case "timer":
      return "scheduled heartbeat";
    case "assignment":
      return "assigned work";
    case "automation":
      return "automation wake";
    case "on_demand":
      return run.triggerDetail === "manual" ? "manual run" : "on-demand run";
    default:
      return "Paperclip wake";
  }
}

export function describeRunWork(run: HeartbeatRun, touchedIssues?: IssueForRun[] | null): string {
  if (touchedIssues && touchedIssues.length === 1) {
    return `It touched ${formatIssueLabel(touchedIssues[0])}.`;
  }
  if (touchedIssues && touchedIssues.length > 1) {
    return `It touched ${touchedIssues.length} issues.`;
  }

  const context = readRunContext(run);
  const issueId = asNonEmptyString(context?.issueId);
  if (issueId) return `It was scoped to issue ${issueId.slice(0, 8)}.`;

  const taskKey = asNonEmptyString(context?.taskKey) ?? asNonEmptyString(context?.taskId);
  if (taskKey) return `It ran inside task scope ${taskKey}.`;

  return "No issue or task link was recorded for this run.";
}

export function describeRunOutcome(run: HeartbeatRun, touchedIssues?: IssueForRun[] | null): string {
  switch (run.status) {
    case "queued":
      return "It is queued and has not started yet.";
    case "running":
      return "It is still running.";
    case "succeeded":
      if (touchedIssues && touchedIssues.length > 0) {
        return `It finished cleanly after touching ${touchedIssues.length} issue${touchedIssues.length === 1 ? "" : "s"}.`;
      }
      return "It finished cleanly.";
    case "timed_out":
      return "It stopped because the runtime timeout was hit.";
    case "failed":
      return "It stopped with an error before it finished.";
    case "cancelled":
      return "It was cancelled before completion.";
    default:
      return `It ended with status ${humanizeKey(run.status)}.`;
  }
}

export function describeRunSession(run: HeartbeatRun): string {
  const context = readRunContext(run);
  const sessionChanged =
    Boolean(run.sessionIdBefore) &&
    Boolean(run.sessionIdAfter) &&
    run.sessionIdBefore !== run.sessionIdAfter;

  if (!run.sessionIdBefore && !run.sessionIdAfter) {
    return "No reusable session was recorded for this run.";
  }

  if (sessionChanged) {
    if (context?.forceFreshSession === true) {
      return "It started a fresh session because a fresh session was explicitly requested.";
    }
    if (asNonEmptyString(context?.wakeReason) === "issue_assigned") {
      return "It started a fresh session because this wake came from a new issue assignment.";
    }
    return "It switched to a different session during the run.";
  }

  if (run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore === run.sessionIdAfter) {
    return "It kept using the same session throughout the run.";
  }

  if (!run.sessionIdBefore && run.sessionIdAfter) {
    return "It started a new session for this run.";
  }

  return "Session continuity is only partially recorded for this run.";
}

export function buildRunNarrative(run: HeartbeatRun, touchedIssues?: IssueForRun[] | null): RunNarrative {
  const reason = describeRunReason(run);
  const outcome = describeRunOutcome(run, touchedIssues);
  return {
    why: `This run started because ${reason}.`,
    work: describeRunWork(run, touchedIssues),
    outcome,
    session: describeRunSession(run),
    compact: `${capitalize(reason)}. ${outcome}`,
  };
}

export function detectRunDiagnostic(run: HeartbeatRun, combinedText?: string | null): RunDiagnostic | null {
  const text = [
    run.error,
    run.stderrExcerpt,
    run.stdoutExcerpt,
    combinedText,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (run.status === "timed_out") {
    return { tone: "error", text: "This run actually timed out." };
  }

  if (run.errorCode === "tool_runtime_unavailable" || TOOL_RUNTIME_FAILURE_RE.test(text)) {
    return {
      tone: "error",
      text: "This failed because the local exec/tool runtime was unavailable, not because of model behavior.",
    };
  }

  if (QUOTA_OR_RATE_LIMIT_RE.test(text)) {
    return { tone: "warn", text: "This looks like a quota or rate-limit problem, not a timeout." };
  }

  if (run.errorCode === "process_lost") {
    return { tone: "warn", text: "The worker process disappeared mid-run, so Paperclip marked it as failed." };
  }

  if (run.errorCode === "claude_auth_required") {
    return { tone: "warn", text: "The Claude adapter needed a fresh login before it could keep running." };
  }

  if (run.status === "succeeded" && (LOG_TIMED_OUT_FALSE_RE.test(text) || LOG_TIMEOUT_CONFIG_RE.test(text))) {
    return {
      tone: "info",
      text: "This run did not time out. A log like `timeout=1800s` is just the configured limit, not a failure.",
    };
  }

  if (run.status === "failed") {
    return {
      tone: "warn",
      text: "This failed, but it does not read like a Paperclip timeout. Check the raw transcript for the adapter error.",
    };
  }

  return null;
}
