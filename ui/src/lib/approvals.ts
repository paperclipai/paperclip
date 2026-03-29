import type { Approval } from "@paperclipai/shared";

export type ApprovalLane = "marketing" | "intake" | "ops" | "unknown";
export type ContentTier = "blog" | "social" | "outreach";

export const CONTENT_TIER_ORDER: ContentTier[] = ["blog", "social", "outreach"];
export const CONTENT_TIER_LABELS: Record<ContentTier, string> = {
  blog: "Blog · Tier 1",
  social: "Social · Tier 2",
  outreach: "Outreach · Tier 3",
};

const APPROVAL_STATUS_PRIORITY: Record<string, number> = {
  revision_requested: 0,
  pending: 1,
  approved: 2,
  rejected: 3,
  cancelled: 4,
  draft: 5,
};

export function approvalStatusRank(status: Approval["status"]): number {
  return APPROVAL_STATUS_PRIORITY[status] ?? 99;
}

export function compareApprovalsByStatusThenCreated(a: Approval, b: Approval): number {
  const statusDelta = approvalStatusRank(a.status) - approvalStatusRank(b.status);
  if (statusDelta !== 0) return statusDelta;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function compareApprovalsByStatusThenUpdated(a: Approval, b: Approval): number {
  const statusDelta = approvalStatusRank(a.status) - approvalStatusRank(b.status);
  if (statusDelta !== 0) return statusDelta;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

const STALE_APPROVAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function approvalNeedsReminder(approval: Approval, nowMs = Date.now()): boolean {
  if (approval.status !== "pending" && approval.status !== "revision_requested") return false;
  return nowMs - new Date(approval.updatedAt).getTime() >= STALE_APPROVAL_THRESHOLD_MS;
}

export function approvalAgeHours(approval: Approval, nowMs = Date.now()): number {
  const updatedAt = new Date(approval.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return 0;
  const diff = nowMs - updatedAt;
  if (diff <= 0) return 0;
  return Math.floor(diff / (60 * 60 * 1000));
}

function getPayloadText(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";
  const lane = typeof payload.lane === "string" ? payload.lane : "";
  const channel = typeof payload.channel === "string" ? payload.channel : "";
  const category = typeof payload.category === "string" ? payload.category : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const strategy = typeof payload.strategy === "string" ? payload.strategy : "";
  const requestedAction = typeof payload.requestedAction === "string" ? payload.requestedAction : "";
  const draft = typeof payload.draft === "string" ? payload.draft : "";
  const drafts = payload.drafts && typeof payload.drafts === "object" ? Object.keys(payload.drafts as Record<string, unknown>).join(" ") : "";
  const draftPath = typeof payload.draft_path === "string" ? payload.draft_path : "";
  const draftPaths = Array.isArray(payload.draft_paths) ? payload.draft_paths.filter((v): v is string => typeof v === "string").join(" ") : "";
  return `${lane} ${channel} ${category} ${title} ${summary} ${strategy} ${requestedAction} ${drafts} ${draft} ${draftPath} ${draftPaths}`.toLowerCase();
}

export function approvalLane(approval: Approval): ApprovalLane {
  const raw = getPayloadText(approval.payload as Record<string, unknown> | null | undefined);

  // Marketing-first so outreach/prospect content does not get misrouted into Intake.
  if (
    raw.includes("linkedin") ||
    raw.includes("x") ||
    raw.includes("social") ||
    raw.includes("blog") ||
    raw.includes("website") ||
    raw.includes("content") ||
    raw.includes("launch") ||
    raw.includes("outreach") ||
    raw.includes("email") ||
    raw.includes("prospect")
  ) {
    return "marketing";
  }

  if (raw.includes("ops") || raw.includes("trading bot") || raw.includes("rag control") || raw.includes("control tower")) return "ops";
  if (raw.includes("intake") || raw.includes("wind tech")) return "intake";
  return "unknown";
}

export function contentTier(approval: Approval): ContentTier {
  const raw = getPayloadText(approval.payload as Record<string, unknown> | null | undefined);

  if (
    raw.includes("outreach") ||
    raw.includes("linkedin-outreach") ||
    raw.includes("email") ||
    raw.includes("prospect")
  ) {
    return "outreach";
  }

  if (
    raw.includes("linkedin") ||
    raw.includes("x post") ||
    raw.includes("social") ||
    raw.includes("x/") ||
    raw.includes("linkedin+x")
  ) {
    return "social";
  }

  if (raw.includes("blog") || raw.includes("website")) {
    return "blog";
  }

  // Default marketing tier fallback.
  return "social";
}

export function approvalLaneLabel(lane: ApprovalLane): string {
  if (lane === "marketing") return "Marketing";
  if (lane === "intake") return "Intake";
  if (lane === "ops") return "Ops";
  return "Unknown";
}
