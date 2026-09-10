import type { IssueStatus } from "../constants.js";

/**
 * Board read projection for one issue, batched over an explicit issue-id list.
 *
 * `phase` and `status` are deliberately separate facts. Status is the backend
 * lifecycle (including the `blocked` safety state); phase is the human workflow
 * phase the board projects. For a non-blocked task it is the status itself. For a
 * task held by a delivery blocker or a `blocked` status it is the supported
 * evidence — current delivery phase, otherwise the latest audited non-blocked
 * transition, otherwise an explicit execution stage. `phase: null` with
 * `phaseSource: "unknown"` means no phase was ever recorded: it is never a
 * synonym for "not started" and never hides the task.
 */
export interface IssueOverviewRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface IssueOverviewPullRequest {
  /** HTTP(S) only; any other scheme or a malformed value is `null`. */
  url: string | null;
  number: number | null;
  repository: string | null;
  state: "draft" | "open" | "closed" | "merged" | "unknown";
  updatedAt: string | null;
  /**
   * The recorded observation is not a fresh provider observation. A stale pull
   * request keeps its last known state — it is never reported as absent.
   */
  stale: boolean;
}

export interface IssueOverview {
  issueId: string;
  phase: Exclude<IssueStatus, "blocked"> | null;
  phaseSource: "status" | "delivery" | "history" | "execution" | "unknown";
  blocked: boolean;
  project: { id: string; name: string; color: string | null } | null;
  parent: IssueOverviewRef | null;
  children: IssueOverviewRef[];
  /** Every direct child, including cancelled ones. */
  childCount: number;
  /** Children that reached `done`. A cancelled child is closed, not delivered. */
  completedChildCount: number;
  blocker: {
    message: string;
    ownerLabel: string | null;
    nextAction: string | null;
    issues: IssueOverviewRef[];
  } | null;
  pullRequests: IssueOverviewPullRequest[];
  delivery: {
    /**
     * `merged` for a merged unit that is still this cycle's outcome; otherwise
     * the canonical delivery phase. A merge superseded by a later live cycle is
     * history: it stays in `pullRequests` and this block is `null`.
     */
    phase: string;
    artifactReady: boolean;
    reviewStatus: string;
    blockingFindings: number;
    queuePosition: number | null;
    nextAction: string | null;
    lastEventAt: string | null;
    /**
     * Merge time of this cycle's unit. A merged outcome requires the task to be
     * `done` with `phase === "merged"` and this value — never a lone or merely
     * refreshed pull request.
     */
    mergedAt: string | null;
  } | null;
}

export interface IssueOverviewsResponse {
  items: IssueOverview[];
  observedAt: string;
}
