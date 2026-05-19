// Pure helpers behind the LET-484 `/eaos/runs` zone. Source of truth is the
// canonical company activity feed (`activityApi.list`) — every event with a
// non-null `runId` is a run-scoped breadcrumb. We collapse those into a
// per-run summary so the operator sees one row per run (latest action,
// agent, target, when) without scrolling through ten breadcrumb rows.
//
// Replay / transcript / tool-call timelines live inside Mission detail
// (`/eaos/missions/:missionRef`) and the kernel issue page — this surface
// only routes operators to them.

import type { ActivityEvent } from "@paperclipai/shared";

export interface RunTimelineRow {
  readonly runId: string;
  readonly latestAction: string;
  readonly latestActorType: ActivityEvent["actorType"];
  readonly latestActorId: string;
  readonly agentId: string | null;
  readonly issueId: string | null;
  readonly issueIdentifier: string | null;
  readonly issueTitle: string | null;
  readonly lastActivityAt: Date;
  readonly eventCount: number;
}

export interface RunTimelineCounts {
  readonly totalRuns: number;
  readonly totalEvents: number;
  readonly distinctAgents: number;
  readonly distinctIssues: number;
  readonly lastEventAt: Date | null;
}

function toDate(value: ActivityEvent["createdAt"]): Date {
  if (value instanceof Date) return value;
  return new Date(value as unknown as string);
}

function pickString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function collapseEventsToRuns(events: readonly ActivityEvent[]): RunTimelineRow[] {
  const byRun = new Map<string, RunTimelineRow>();
  for (const event of events) {
    if (!event.runId) continue;
    const at = toDate(event.createdAt);
    const existing = byRun.get(event.runId);
    if (existing && existing.lastActivityAt.getTime() >= at.getTime()) {
      byRun.set(event.runId, {
        ...existing,
        eventCount: existing.eventCount + 1,
        // Backfill issue context from older breadcrumbs if the latest event
        // didn't include it but an earlier one did.
        issueId: existing.issueId ?? extractIssueId(event),
        issueIdentifier: existing.issueIdentifier ?? pickString(event.details, "identifier"),
        issueTitle: existing.issueTitle ?? pickString(event.details, "issueTitle") ?? pickString(event.details, "title"),
      });
      continue;
    }
    byRun.set(event.runId, {
      runId: event.runId,
      latestAction: event.action,
      latestActorType: event.actorType,
      latestActorId: event.actorId,
      agentId: event.agentId,
      issueId: extractIssueId(event),
      issueIdentifier: pickString(event.details, "identifier") ?? pickString(event.details, "issueIdentifier"),
      issueTitle: pickString(event.details, "issueTitle") ?? pickString(event.details, "title"),
      lastActivityAt: at,
      eventCount: (existing?.eventCount ?? 0) + 1,
    });
  }
  return Array.from(byRun.values()).sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );
}

function extractIssueId(event: ActivityEvent): string | null {
  if (event.entityType === "issue") return event.entityId;
  return pickString(event.details, "issueId");
}

export function summarizeRunTimeline(events: readonly ActivityEvent[]): RunTimelineCounts {
  const runIds = new Set<string>();
  const agents = new Set<string>();
  const issues = new Set<string>();
  let last: number = 0;
  let totalEvents = 0;
  for (const event of events) {
    if (event.runId) {
      runIds.add(event.runId);
      totalEvents += 1;
      if (event.agentId) agents.add(event.agentId);
      const issue = extractIssueId(event);
      if (issue) issues.add(issue);
      const at = toDate(event.createdAt).getTime();
      if (Number.isFinite(at) && at > last) last = at;
    }
  }
  return {
    totalRuns: runIds.size,
    totalEvents,
    distinctAgents: agents.size,
    distinctIssues: issues.size,
    lastEventAt: last > 0 ? new Date(last) : null,
  };
}

export const RUNS_TIMELINE_TEST_HELPERS = { toDate, extractIssueId };
