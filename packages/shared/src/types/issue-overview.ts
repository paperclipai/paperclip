import type { IssueStatus } from "../constants.js";
import type {
  DeliveryAutoDeployDisposition,
  DeliveryPolicyAuthorizationState,
} from "./delivery.js";

/**
 * Evidence readiness of the current delivery candidate, before the final
 * authority gate. `accepted` means fresh evidence satisfied the acceptance
 * criteria for the current head — it is readiness, never merge or deployment
 * authority.
 */
export const ISSUE_DELIVERY_READINESS = [
  "not_started",
  "under_review",
  "accepted",
  "blocked",
  "unknown",
] as const;
export type IssueDeliveryReadiness = (typeof ISSUE_DELIVERY_READINESS)[number];

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
    /** Candidate generation every fact in this block was read at. */
    candidateGeneration: number;
    /**
     * Evidence readiness before the final gate: a candidate can be `accepted`
     * on fresh review/check evidence and still be held by the authorization or
     * deployment gate described below.
     */
    readiness: IssueDeliveryReadiness;
    /**
     * The standing policy facts the final gate reads. `authorizationState`
     * distinguishes recorded authority from one that was never recorded and
     * from one a material scope change voided; `autoDeployDisposition` states
     * deployment behaviour, which is separate from merge authority.
     */
    policy: {
      version: number;
      authorizationState: DeliveryPolicyAuthorizationState;
      authorizationInvalidatedScope: string[];
      autoDeployDisposition: DeliveryAutoDeployDisposition;
    } | null;
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
