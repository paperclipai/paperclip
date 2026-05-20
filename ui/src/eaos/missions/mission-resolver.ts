// LET-424 mission resolver: derive a read-only Mission Control task-object
// view from canonical Paperclip `Issue` records.
//
// Truth posture, per LET-409 §8 / §10 / §15:
//   - `Backend-backed` (`BACKEND-BACKED` chip) when a value comes directly from
//     the canonical Issue read model.
//   - `Backend-derived` (`PREVIEW` chip with `Backend-derived` prefix) when the
//     value is computed from backend-backed fields by a documented resolver,
//     rollup, or classifier defined in this module.
//   - `Preview` / `Stub` / `Live` are not produced by this resolver because the
//     LET-424 slice is read-only and reads from the existing canonical issues
//     endpoint only.
//
// This resolver intentionally never inflates counts with preview/stub data,
// never reaches for a separate "mission" endpoint, and never emits raw secrets
// because it only reflects already-stored canonical Issue fields (title,
// status, assignee IDs, blocker summaries, updatedAt) — none of which carry
// secret payloads by contract.

import type { Issue, IssueStatus } from "@paperclipai/shared";

export type MissionTruthLabel = "Backend-backed" | "Backend-derived";

export type MissionFreshnessLabel = "Fresh" | "Aging" | "Stale" | "Unknown";

export type MissionPrimaryState =
  | "active"
  | "needs-next-owner"
  | "blocked"
  | "in-review"
  | "release-held"
  | "done-with-evidence"
  | "done-evidence-incomplete"
  | "cancelled"
  | "stale";

export interface MissionRow {
  readonly id: string;
  readonly identifier: string | null;
  readonly title: string;
  readonly backendStatus: IssueStatus;
  readonly primaryState: MissionPrimaryState;
  readonly primaryStateReason: string;
  readonly truthLabel: MissionTruthLabel;
  readonly freshness: MissionFreshnessLabel;
  readonly updatedAt: Date | null;
  readonly ownerSummary: {
    readonly currentLabel: string;
    readonly currentTruth: MissionTruthLabel;
    readonly currentReason: string;
  };
  readonly evidenceSummary: {
    readonly hasPlanDocument: boolean;
    readonly hasWorkProducts: boolean;
    readonly truth: MissionTruthLabel;
  };
  readonly riskSummary: {
    readonly severity: "none" | "low" | "elevated";
    readonly liveActionMentioned: boolean;
    readonly truth: MissionTruthLabel;
  };
  readonly nextGateSummary: {
    readonly label: string;
    readonly truth: MissionTruthLabel;
    readonly requiresHuman: boolean;
  };
  readonly treeSummary: {
    readonly blockedByCount: number;
    readonly blocksCount: number;
    readonly truth: MissionTruthLabel;
  };
  readonly kernelRoute: string;
}

export interface MissionListBuckets {
  readonly active: MissionRow[];
  readonly blocked: MissionRow[];
  readonly inReview: MissionRow[];
  readonly doneWithEvidence: MissionRow[];
  readonly other: MissionRow[];
}

export interface MissionListSummary {
  readonly totalBackendBacked: number;
  readonly active: number;
  readonly blocked: number;
  readonly inReview: number;
  readonly doneWithEvidence: number;
  readonly stale: number;
}

const FRESHNESS_FRESH_MS = 60 * 60 * 1000;
const FRESHNESS_AGING_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// Keywords that signal a risky/live category in the issue title. The match is
// deliberately conservative — false positives are acceptable for a non-gating
// "elevated risk" advisory chip; false negatives are not. We never inspect the
// issue description because that body can carry user paste-throughs.
const LIVE_RISK_KEYWORDS = [
  "deploy",
  "restart",
  "production",
  "prod migration",
  "spend",
  "credential",
  "proxy",
  "live ",
  "vendor",
  "destructive",
  "rollout",
  "release approval",
];

function resolveFreshness(updatedAt: Date | null, now: Date): MissionFreshnessLabel {
  if (!updatedAt) return "Unknown";
  const ageMs = now.getTime() - updatedAt.getTime();
  if (Number.isNaN(ageMs) || ageMs < 0) return "Unknown";
  if (ageMs <= FRESHNESS_FRESH_MS) return "Fresh";
  if (ageMs <= FRESHNESS_AGING_MS) return "Aging";
  if (ageMs <= FRESHNESS_STALE_MS) return "Aging";
  return "Stale";
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolvePrimaryState(
  issue: Issue,
  freshness: MissionFreshnessLabel,
): { state: MissionPrimaryState; reason: string } {
  if (issue.status === "cancelled") {
    return { state: "cancelled", reason: "Cancelled" };
  }
  const blockerCount = issue.blockedBy?.length ?? 0;
  if (issue.status === "blocked" || blockerCount > 0) {
    return {
      state: "blocked",
      reason:
        blockerCount > 0
          ? `Blocked by ${blockerCount} dependency issue${blockerCount === 1 ? "" : "s"}`
          : "Waiting on an external unblock",
    };
  }
  if (issue.status === "in_review") {
    return { state: "in-review", reason: "Awaiting reviewer or approval" };
  }
  if (issue.status === "done") {
    const hasEvidence =
      Boolean(issue.planDocument) ||
      (issue.documentSummaries?.length ?? 0) > 0 ||
      (issue.workProducts?.length ?? 0) > 0;
    return hasEvidence
      ? { state: "done-with-evidence", reason: "Closed with evidence attached" }
      : { state: "done-evidence-incomplete", reason: "Closed; no evidence attached yet" };
  }
  if (issue.status === "in_progress") {
    return { state: "active", reason: "In progress" };
  }
  if (issue.status === "todo" || issue.status === "backlog") {
    if (!issue.assigneeAgentId && !issue.assigneeUserId) {
      return { state: "needs-next-owner", reason: "No owner assigned yet" };
    }
    return { state: "active", reason: "Assigned and queued" };
  }
  if (freshness === "Stale") {
    return { state: "stale", reason: "No recent activity" };
  }
  return { state: "active", reason: "In progress" };
}

function resolveOwner(issue: Issue): MissionRow["ownerSummary"] {
  if (issue.assigneeUserId) {
    return {
      currentLabel: "Human teammate",
      currentTruth: "Backend-backed",
      currentReason: "Assigned to a human teammate",
    };
  }
  if (issue.assigneeAgentId) {
    return {
      currentLabel: "Agent",
      currentTruth: "Backend-backed",
      currentReason: "Assigned to an agent",
    };
  }
  if (issue.executionAgentNameKey) {
    return {
      currentLabel: "Role-based agent",
      currentTruth: "Backend-backed",
      currentReason: "Picked up by a role-based agent",
    };
  }
  return {
    currentLabel: "Unassigned",
    currentTruth: "Backend-derived",
    currentReason: "No owner assigned yet",
  };
}

function resolveEvidence(issue: Issue): MissionRow["evidenceSummary"] {
  return {
    hasPlanDocument: Boolean(issue.planDocument) || (issue.documentSummaries?.length ?? 0) > 0,
    hasWorkProducts: (issue.workProducts?.length ?? 0) > 0,
    truth: "Backend-backed",
  };
}

function resolveRisk(issue: Issue): MissionRow["riskSummary"] {
  const haystack = (issue.title ?? "").toLowerCase();
  const liveActionMentioned = LIVE_RISK_KEYWORDS.some((kw) => haystack.includes(kw));
  return {
    severity: liveActionMentioned ? "elevated" : "low",
    liveActionMentioned,
    truth: "Backend-derived",
  };
}

function resolveNextGate(
  issue: Issue,
  primaryState: MissionPrimaryState,
): MissionRow["nextGateSummary"] {
  if (primaryState === "blocked") {
    return {
      label: "Unblock dependency",
      truth: "Backend-derived",
      requiresHuman: false,
    };
  }
  if (primaryState === "in-review") {
    return {
      label: "Review/approval owner action",
      truth: "Backend-derived",
      requiresHuman: true,
    };
  }
  if (primaryState === "done-with-evidence") {
    return { label: "None — done", truth: "Backend-derived", requiresHuman: false };
  }
  if (primaryState === "done-evidence-incomplete") {
    return {
      label: "Attach evidence to complete",
      truth: "Backend-derived",
      requiresHuman: false,
    };
  }
  if (primaryState === "needs-next-owner") {
    return {
      label: "Assign next owner",
      truth: "Backend-derived",
      requiresHuman: true,
    };
  }
  if (primaryState === "cancelled") {
    return { label: "None — cancelled", truth: "Backend-derived", requiresHuman: false };
  }
  return { label: "Continue active work", truth: "Backend-derived", requiresHuman: false };
}

function resolveTree(issue: Issue): MissionRow["treeSummary"] {
  return {
    blockedByCount: issue.blockedBy?.length ?? 0,
    blocksCount: issue.blocks?.length ?? 0,
    truth: "Backend-backed",
  };
}

export function resolveMissionRow(issue: Issue, now: Date = new Date()): MissionRow {
  const updatedAt = coerceDate(issue.updatedAt);
  const freshness = resolveFreshness(updatedAt, now);
  const { state, reason } = resolvePrimaryState(issue, freshness);
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    backendStatus: issue.status,
    primaryState: state,
    primaryStateReason: reason,
    truthLabel: "Backend-backed",
    freshness,
    updatedAt,
    ownerSummary: resolveOwner(issue),
    evidenceSummary: resolveEvidence(issue),
    riskSummary: resolveRisk(issue),
    nextGateSummary: resolveNextGate(issue, state),
    treeSummary: resolveTree(issue),
    kernelRoute: `/issues/${issue.id}`,
  };
}

export function bucketMissions(rows: readonly MissionRow[]): MissionListBuckets {
  const active: MissionRow[] = [];
  const blocked: MissionRow[] = [];
  const inReview: MissionRow[] = [];
  const doneWithEvidence: MissionRow[] = [];
  const other: MissionRow[] = [];
  for (const row of rows) {
    switch (row.primaryState) {
      case "blocked":
        blocked.push(row);
        break;
      case "in-review":
        inReview.push(row);
        break;
      case "done-with-evidence":
        doneWithEvidence.push(row);
        break;
      case "active":
        active.push(row);
        break;
      default:
        other.push(row);
    }
  }
  return { active, blocked, inReview, doneWithEvidence, other };
}

export function summarizeMissionList(rows: readonly MissionRow[]): MissionListSummary {
  let active = 0;
  let blocked = 0;
  let inReview = 0;
  let doneWithEvidence = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.primaryState === "active") active += 1;
    if (row.primaryState === "blocked") blocked += 1;
    if (row.primaryState === "in-review") inReview += 1;
    if (row.primaryState === "done-with-evidence") doneWithEvidence += 1;
    if (row.freshness === "Stale") stale += 1;
  }
  return {
    totalBackendBacked: rows.length,
    active,
    blocked,
    inReview,
    doneWithEvidence,
    stale,
  };
}
