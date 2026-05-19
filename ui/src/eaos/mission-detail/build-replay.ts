// LET-467 — client-side replay adapter per the LET-465 design contract §6.
//
// Replay merges run/activity/comment/validation/document events into a single
// time-ordered audit trail. Pure data-only; the UI lives in
// `MissionReplayFeed.tsx`.

import type {
  ActivityEvent,
  Approval,
  IssueComment,
  IssueDocumentSummary,
  IssueThreadInteraction,
  IssueTreeObservability,
  IssueValidationHistory,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { maskFinalDeliveryDestination } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import type { RunForIssue } from "@/api/activity";
import { redactSecretLikeText, safeDisplayText } from "../secret-redact";

export type ReplayKind =
  | "run"
  | "live_run"
  | "comment"
  | "document"
  | "work_product"
  | "validation"
  | "approval"
  | "interaction"
  | "final_delivery"
  | "activity"
  | "tree_event";

export type ReplaySeverity = "info" | "live" | "success" | "warning" | "error";

export interface ReplayItem {
  readonly id: string;
  readonly kind: ReplayKind;
  readonly timestamp: string;
  readonly title: string;
  readonly summary: string | null;
  readonly actor: string | null;
  readonly state: string | null;
  readonly severity: ReplaySeverity;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function pushIf(items: ReplayItem[], item: ReplayItem | null) {
  if (item) items.push(item);
}

function severityForRunStatus(status: string): ReplaySeverity {
  if (status === "running" || status === "queued" || status === "active") return "live";
  if (status === "completed" || status === "succeeded") return "success";
  if (status === "failed" || status === "error" || status === "exhausted") return "error";
  return "info";
}

function severityForValidation(verdict: string | null | undefined): ReplaySeverity {
  if (!verdict) return "info";
  const v = verdict.toUpperCase();
  if (v.includes("PASS") || v.includes("APPROVE")) return "success";
  if (v.includes("FAIL") || v.includes("REJECT")) return "error";
  if (v.includes("REVISION") || v.includes("CHANGES")) return "warning";
  return "info";
}

function runReplayItem(run: RunForIssue): ReplayItem | null {
  const ts = toIso(run.finishedAt ?? run.startedAt ?? run.createdAt);
  if (!ts) return null;
  return {
    id: `run:${run.runId}`,
    kind: "run",
    timestamp: ts,
    title: `Run · ${run.status}`,
    summary: safeDisplayText(run.nextAction ?? run.livenessReason ?? null),
    actor: `agent:${run.agentId}`,
    state: run.status,
    severity: severityForRunStatus(run.status),
  };
}

function liveReplayItem(
  run: LiveRunForIssue | ActiveRunForIssue,
  kind: "live" | "active",
): ReplayItem | null {
  const ts = toIso(run.finishedAt ?? run.startedAt ?? run.createdAt);
  if (!ts) return null;
  return {
    id: `${kind}:${run.id}`,
    kind: "live_run",
    timestamp: ts,
    title: `${kind === "active" ? "Active run" : "Live run"} · ${run.agentName}`,
    summary: safeDisplayText(run.nextAction ?? run.livenessReason ?? null),
    actor: `agent:${run.agentId}`,
    state: run.status,
    severity: "live",
  };
}

function commentReplayItem(comment: IssueComment): ReplayItem | null {
  const ts = toIso(comment.createdAt);
  if (!ts) return null;
  return {
    id: `cmt:${comment.id}`,
    kind: "comment",
    timestamp: ts,
    title: redactSecretLikeText(
      comment.presentation?.title
        ?? (comment.authorType === "agent"
          ? "Agent comment"
          : comment.authorType === "user"
            ? "User comment"
            : "System note"),
    ),
    summary: safeDisplayText(comment.body),
    actor: comment.authorAgentId
      ? `agent:${comment.authorAgentId}`
      : comment.authorUserId
        ? `user:${comment.authorUserId}`
        : "system",
    state: null,
    severity: comment.authorType === "system" ? "info" : "info",
  };
}

function documentReplayItem(doc: IssueDocumentSummary): ReplayItem | null {
  const ts = toIso(doc.updatedAt ?? doc.createdAt);
  if (!ts) return null;
  return {
    id: `doc:${doc.id}`,
    kind: "document",
    timestamp: ts,
    title: redactSecretLikeText(`Document · ${doc.title ?? doc.key}`),
    summary: `Revision ${doc.latestRevisionNumber}`,
    actor: null,
    state: null,
    severity: "info",
  };
}

function workProductReplayItem(wp: IssueWorkProduct): ReplayItem | null {
  const ts = toIso(wp.updatedAt ?? wp.createdAt);
  if (!ts) return null;
  return {
    id: `wp:${wp.id}`,
    kind: "work_product",
    timestamp: ts,
    title: redactSecretLikeText(`Work product · ${wp.title}`),
    summary: safeDisplayText(wp.summary ?? null),
    actor: null,
    state: wp.status,
    severity: "info",
  };
}

function validationReplayItems(history: IssueValidationHistory | null | undefined): ReplayItem[] {
  if (!history) return [];
  const out: ReplayItem[] = [];
  for (const entry of history.entries) {
    const ts = toIso(entry.createdAt);
    if (!ts) continue;
    out.push({
      id: `val:${entry.id}`,
      kind: "validation",
      timestamp: ts,
      title: redactSecretLikeText(`Validation · ${entry.verdict ?? entry.label}`),
      summary: safeDisplayText(entry.summary ?? entry.bodyPreview ?? null),
      actor: entry.actorAgentId
        ? `agent:${entry.actorAgentId}`
        : entry.actorUserId
          ? `user:${entry.actorUserId}`
          : null,
      state: entry.verdict ?? null,
      severity: severityForValidation(entry.verdict),
    });
  }
  return out;
}

function approvalReplayItem(approval: Approval): ReplayItem | null {
  const ts = toIso(approval.decidedAt ?? approval.updatedAt ?? approval.createdAt);
  if (!ts) return null;
  return {
    id: `appr:${approval.id}`,
    kind: "approval",
    timestamp: ts,
    title: `Approval · ${approval.type}`,
    summary: safeDisplayText(approval.decisionNote ?? null),
    actor: approval.decidedByUserId ? `user:${approval.decidedByUserId}` : null,
    state: approval.status,
    severity:
      approval.status === "approved"
        ? "success"
        : approval.status === "rejected"
          ? "error"
          : "warning",
  };
}

function interactionReplayItem(interaction: IssueThreadInteraction): ReplayItem | null {
  const ts = toIso(interaction.resolvedAt ?? interaction.updatedAt ?? interaction.createdAt);
  if (!ts) return null;
  if (interaction.kind === "final_delivery") {
    const dest = interaction.payload?.destination;
    const masked = dest ? maskFinalDeliveryDestination(dest) : "destination redacted";
    const result = interaction.result;
    const error = result?.error ? safeDisplayText(result.error) : null;
    return {
      id: `int:${interaction.id}`,
      kind: "final_delivery",
      timestamp: ts,
      title: `Final delivery · ${result?.outcome ?? interaction.status}`,
      summary: [masked, error].filter(Boolean).join(" · ") || null,
      actor: null,
      state: result?.outcome ?? interaction.status,
      severity:
        result?.outcome === "delivered"
          ? "success"
          : result?.outcome === "failed"
            ? "error"
            : "info",
    };
  }
  return {
    id: `int:${interaction.id}`,
    kind: "interaction",
    timestamp: ts,
    title: `Interaction · ${interaction.kind}`,
    summary: safeDisplayText(interaction.summary ?? null),
    actor: null,
    state: interaction.status,
    severity: "info",
  };
}

function activityReplayItem(event: ActivityEvent): ReplayItem | null {
  const ts = toIso(event.createdAt);
  if (!ts) return null;
  return {
    id: `act:${event.id}`,
    kind: "activity",
    timestamp: ts,
    title: `Activity · ${event.action}`,
    summary:
      event.details && typeof event.details === "object"
        ? safeDisplayText(JSON.stringify(event.details), 200)
        : null,
    actor: event.actorType === "agent" ? `agent:${event.actorId}` : event.actorType === "user" ? `user:${event.actorId}` : event.actorType,
    state: null,
    severity: "info",
  };
}

function treeReplayItems(tree: IssueTreeObservability | null | undefined): ReplayItem[] {
  if (!tree) return [];
  const out: ReplayItem[] = [];
  for (const entry of tree.timeline) {
    const ts = toIso(entry.timestamp);
    if (!ts) continue;
    const severity: ReplaySeverity =
      entry.severity === "error"
        ? "error"
        : entry.severity === "warning"
          ? "warning"
          : entry.severity === "success"
            ? "success"
            : "info";
    out.push({
      id: `tree:${entry.id}`,
      kind: "tree_event",
      timestamp: ts,
      title: redactSecretLikeText(`${entry.kind} · ${entry.label}`),
      summary: safeDisplayText(entry.message ?? null),
      actor: null,
      state: entry.severity,
      severity,
    });
  }
  return out;
}

export interface BuildReplayInput {
  runs?: ReadonlyArray<RunForIssue> | null;
  liveRuns?: ReadonlyArray<LiveRunForIssue> | null;
  activeRun?: ActiveRunForIssue | null;
  comments?: ReadonlyArray<IssueComment> | null;
  documents?: ReadonlyArray<IssueDocumentSummary> | null;
  workProducts?: ReadonlyArray<IssueWorkProduct> | null;
  validation?: IssueValidationHistory | null;
  approvals?: ReadonlyArray<Approval> | null;
  interactions?: ReadonlyArray<IssueThreadInteraction> | null;
  activity?: ReadonlyArray<ActivityEvent> | null;
  treeObservability?: IssueTreeObservability | null;
}

export function buildReplayItems(input: BuildReplayInput): ReplayItem[] {
  const items: ReplayItem[] = [];
  const seenLive = new Set<string>();
  if (input.activeRun) {
    const item = liveReplayItem(input.activeRun, "active");
    if (item) {
      seenLive.add(input.activeRun.id);
      items.push(item);
    }
  }
  for (const run of input.liveRuns ?? []) {
    if (seenLive.has(run.id)) continue;
    seenLive.add(run.id);
    pushIf(items, liveReplayItem(run, "live"));
  }
  for (const run of input.runs ?? []) {
    pushIf(items, runReplayItem(run));
  }
  for (const comment of input.comments ?? []) {
    pushIf(items, commentReplayItem(comment));
  }
  for (const doc of input.documents ?? []) {
    pushIf(items, documentReplayItem(doc));
  }
  for (const wp of input.workProducts ?? []) {
    pushIf(items, workProductReplayItem(wp));
  }
  items.push(...validationReplayItems(input.validation ?? null));
  for (const appr of input.approvals ?? []) {
    pushIf(items, approvalReplayItem(appr));
  }
  for (const interaction of input.interactions ?? []) {
    pushIf(items, interactionReplayItem(interaction));
  }
  for (const event of input.activity ?? []) {
    pushIf(items, activityReplayItem(event));
  }
  items.push(...treeReplayItems(input.treeObservability ?? null));
  items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return items;
}
