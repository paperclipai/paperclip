import type { ActivityEvent, IssueWorkMode } from "@paperclipai/shared";
import { isIssueWorkMode } from "@/lib/work-mode-meta";

export interface IssueTimelineAssignee {
  agentId: string | null;
  userId: string | null;
}

export interface IssueTimelineEvent {
  id: string;
  createdAt: Date | string;
  actorType: ActivityEvent["actorType"];
  actorId: string;
  runId?: string | null;
  statusChange?: {
    from: string | null;
    to: string | null;
  };
  assigneeChange?: {
    from: IssueTimelineAssignee;
    to: IssueTimelineAssignee;
  };
  workspaceChange?: {
    from: IssueTimelineWorkspace;
    to: IssueTimelineWorkspace;
  };
  commentId?: string | null;
  followUpRequested?: boolean;
}

export interface IssueTimelineWorkspace {
  label: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  mode: string | null;
}

export function formatTimelineWorkspaceLabel(workspace: IssueTimelineWorkspace) {
  const fallbackId = workspace.executionWorkspaceId ?? workspace.projectWorkspaceId;
  return workspace.label ?? (fallbackId ? fallbackId.slice(0, 8) : "None");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toTimestamp(value: Date | string) {
  return new Date(value).getTime();
}

function sameAssignee(left: IssueTimelineAssignee, right: IssueTimelineAssignee) {
  return left.agentId === right.agentId && left.userId === right.userId;
}

function sameWorkspace(left: IssueTimelineWorkspace, right: IssueTimelineWorkspace) {
  return left.projectWorkspaceId === right.projectWorkspaceId
    && left.executionWorkspaceId === right.executionWorkspaceId
    && left.mode === right.mode
    && left.label === right.label;
}

function workspaceFromRecord(value: unknown): IssueTimelineWorkspace | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    label: nullableString(record.label),
    projectWorkspaceId: nullableString(record.projectWorkspaceId),
    executionWorkspaceId: nullableString(record.executionWorkspaceId),
    mode: nullableString(record.mode),
  };
}

function workspaceChangeFromDetails(details: Record<string, unknown>) {
  const change = asRecord(details.workspaceChange);
  if (!change) return null;
  const from = workspaceFromRecord(change.from);
  const to = workspaceFromRecord(change.to);
  if (!from || !to || sameWorkspace(from, to)) return null;
  return { from, to };
}

function sortTimelineEvents<T extends { createdAt: Date | string; id: string }>(events: T[]) {
  return [...events].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export interface IssueWorkModeChange {
  id: string;
  createdAt: Date | string;
  from: string | null;
  to: string | null;
}

/**
 * Work-mode switch history for an issue, from `issue.updated` activity events
 * (the PATCH route records changed fields plus their `_previous` values).
 * Extracted separately from extractIssueTimelineEvents so mode switches don't
 * become system messages in the thread — they only feed per-reply mode
 * attribution in the task-chat redesign.
 */
export function extractIssueWorkModeChanges(
  activity: ActivityEvent[] | null | undefined,
): IssueWorkModeChange[] {
  const changes: IssueWorkModeChange[] = [];
  for (const event of activity ?? []) {
    if (event.action !== "issue.updated") continue;
    const details = asRecord(event.details);
    if (!details || !hasOwn(details, "workMode")) continue;
    // `_previous` only records fields whose value actually changed — a PATCH
    // that resent the current mode has no `_previous.workMode` and is a no-op.
    const previous = asRecord(details._previous);
    if (!previous || !hasOwn(previous, "workMode")) continue;
    changes.push({
      id: event.id,
      createdAt: event.createdAt,
      from: nullableString(previous.workMode),
      to: nullableString(details.workMode),
    });
  }
  return sortTimelineEvents(changes);
}

/**
 * The issue's work mode in effect at `atMs`, reconstructed from the (sorted)
 * change history: the last change at-or-before `atMs` wins; before the first
 * known change the mode is that change's `from`; with no usable history the
 * `fallback` (the issue's current mode) applies.
 */
export function workModeInEffectAt(
  changes: readonly IssueWorkModeChange[],
  atMs: number,
  fallback: IssueWorkMode,
): IssueWorkMode {
  let mode: IssueWorkMode | null = null;
  for (const change of changes) {
    if (toTimestamp(change.createdAt) <= atMs) {
      if (isIssueWorkMode(change.to)) mode = change.to;
    } else {
      if (mode === null && isIssueWorkMode(change.from)) mode = change.from;
      break;
    }
  }
  return mode ?? fallback;
}

export function extractIssueTimelineEvents(activity: ActivityEvent[] | null | undefined): IssueTimelineEvent[] {
  const events: IssueTimelineEvent[] = [];

  for (const event of activity ?? []) {
    const details = asRecord(event.details);
    if (!details) continue;

    if (event.action === "issue.comment_added") {
      if (details.followUpRequested !== true && details.resumeIntent !== true) continue;
      if (details.reopened === true) continue;
      const commentId = nullableString(details.commentId);
      events.push({
        id: event.id,
        createdAt: event.createdAt,
        actorType: event.actorType,
        actorId: event.actorId,
        runId: event.runId ?? null,
        commentId,
        followUpRequested: true,
      });
      continue;
    }

    if (event.action !== "issue.updated") continue;

    const previous = asRecord(details._previous);
    const timelineEvent: IssueTimelineEvent = {
      id: event.id,
      createdAt: event.createdAt,
      actorType: event.actorType,
      actorId: event.actorId,
      runId: event.runId ?? null,
    };
    if (details.followUpRequested === true || details.resumeIntent === true) {
      timelineEvent.followUpRequested = true;
      timelineEvent.commentId = nullableString(details.commentId);
    }

    if (hasOwn(details, "status")) {
      const from = nullableString(previous?.status) ?? nullableString(details.reopenedFrom);
      const to = nullableString(details.status);
      if (from !== to) {
        timelineEvent.statusChange = { from, to };
      }
    }

    if (hasOwn(details, "assigneeAgentId") || hasOwn(details, "assigneeUserId")) {
      const previousAssignee: IssueTimelineAssignee = {
        agentId: nullableString(previous?.assigneeAgentId),
        userId: nullableString(previous?.assigneeUserId),
      };
      const nextAssignee: IssueTimelineAssignee = {
        agentId: hasOwn(details, "assigneeAgentId")
          ? nullableString(details.assigneeAgentId)
          : previousAssignee.agentId,
        userId: hasOwn(details, "assigneeUserId")
          ? nullableString(details.assigneeUserId)
          : previousAssignee.userId,
      };

      if (!sameAssignee(previousAssignee, nextAssignee)) {
        timelineEvent.assigneeChange = {
          from: previousAssignee,
          to: nextAssignee,
        };
      }
    }

    const workspaceChange = workspaceChangeFromDetails(details);
    if (workspaceChange) {
      timelineEvent.workspaceChange = workspaceChange;
    }

    if (
      timelineEvent.statusChange
      || timelineEvent.assigneeChange
      || timelineEvent.workspaceChange
      || timelineEvent.followUpRequested
    ) {
      events.push(timelineEvent);
    }
  }

  return sortTimelineEvents(events);
}
