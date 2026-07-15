/**
 * Work Timeline (Gantt) types — shared between the aggregation service
 * (`server/src/services/work-timeline.ts`) and the UI page
 * (`ui/src/pages/Timeline.tsx`). Defined here so both sides consume one contract
 * without redefining DTOs. Returned by `GET /api/companies/:companyId/timeline`.
 */

export type TimelineActorType = "agent" | "user" | "system" | "plugin";
export type TimelineEventKind = "created" | "commented" | "approved" | "delegated" | "assigned";
export type TimelineEdgeKind = "delegation" | "assignment" | "mention";

export interface WorkTimelineActor {
  /** Namespaced id, e.g. `agent:<id>`, `user:<id>`, `system:<id>`. */
  id: string;
  type: TimelineActorType;
  name: string;
  avatar?: string | null;
}

export interface WorkTimelineSpan {
  actorId: string;
  laneHint: string | null;
  runId: string;
  issueId: string;
  issueIdentifier: string | null;
  /** Human-readable issue title, shown truncated in the hover tooltip (bars carry no ID). */
  issueTitle: string | null;
  /** ISO timestamp of run start. */
  start: string;
  /** ISO timestamp of run finish, or null when the run is still in progress. */
  end: string | null;
  status: string;
  retryOfRunId?: string | null;
  continuationAttempt?: number;
  invocationSource?: string | null;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

export interface WorkTimelineEvent {
  actorId: string;
  kind: TimelineEventKind;
  issueId: string;
  /** ISO timestamp. */
  at: string;
}

export interface WorkTimelineEdge {
  fromActorId: string;
  toActorId: string;
  issueId: string;
  /** ISO timestamp. */
  at: string;
  kind: TimelineEdgeKind;
}

export interface WorkTimelineResult {
  actors: WorkTimelineActor[];
  spans: WorkTimelineSpan[];
  events: WorkTimelineEvent[];
  edges: WorkTimelineEdge[];
  pagination: {
    limit: number;
    offset: number;
    totalIssues: number;
    hasMore: boolean;
  };
  window: {
    /** ISO timestamp of the window start. */
    from: string;
    /** ISO timestamp of the window end. */
    to: string;
    capped: boolean;
  };
}
