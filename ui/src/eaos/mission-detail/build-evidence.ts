// LET-467 — client-side evidence adapter per the LET-465 design contract §5.
//
// We normalize the eight current Paperclip read endpoints (documents, work
// products, validation history, approvals, interactions, runs, comments,
// tree-observability) into a single set of evidence items the EAOS Mission
// detail surface can render uniformly. Each item carries a truth label so
// the UI never claims a derived value is backend-backed.
//
// Stays pure / data-only. UI lives in `MissionEvidenceBoard.tsx`.

import type {
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
import { safeDisplayText } from "../secret-redact";

export type EvidenceTruthLabel =
  | "backend-backed"
  | "derived"
  | "preview"
  | "unavailable";

export type EvidenceKind =
  | "document"
  | "work_product"
  | "validation"
  | "approval"
  | "final_delivery"
  | "interaction"
  | "run"
  | "live_run"
  | "comment"
  | "tree_event";

export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly title: string;
  readonly summary: string | null;
  readonly timestamp: string | null;
  readonly actor: string | null;
  readonly truthLabel: EvidenceTruthLabel;
  readonly state: string | null;
  readonly sourceLabel: string;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) return null;
    return new Date(ms).toISOString();
  }
  return null;
}

export function buildDocumentEvidence(docs: ReadonlyArray<IssueDocumentSummary>): EvidenceItem[] {
  return docs.map((doc) => ({
    id: `doc:${doc.id}`,
    kind: "document",
    title: doc.title ?? doc.key,
    summary: `Revision ${doc.latestRevisionNumber} — ${doc.key}`,
    timestamp: toIsoString(doc.updatedAt) ?? toIsoString(doc.createdAt),
    actor: null,
    truthLabel: "backend-backed",
    state: null,
    sourceLabel: "Document",
  }));
}

export function buildWorkProductEvidence(items: ReadonlyArray<IssueWorkProduct>): EvidenceItem[] {
  return items.map((wp) => ({
    id: `wp:${wp.id}`,
    kind: "work_product",
    title: wp.title,
    summary: safeDisplayText(wp.summary ?? null) ?? `${wp.type} · ${wp.provider}`,
    timestamp: toIsoString(wp.updatedAt) ?? toIsoString(wp.createdAt),
    actor: null,
    truthLabel: "backend-backed",
    state: wp.status,
    sourceLabel: "Work product",
  }));
}

export function buildValidationEvidence(history: IssueValidationHistory | undefined | null): EvidenceItem[] {
  if (!history) return [];
  return history.entries.map((entry) => ({
    id: `val:${entry.id}`,
    kind: "validation",
    title: entry.label || (entry.verdict ?? "Validator entry"),
    summary: safeDisplayText(entry.summary ?? entry.bodyPreview ?? null),
    timestamp: toIsoString(entry.createdAt),
    actor: entry.actorAgentId ? `agent:${entry.actorAgentId}` : entry.actorUserId ? `user:${entry.actorUserId}` : null,
    truthLabel: "backend-backed",
    state: entry.verdict ?? null,
    sourceLabel: "Validation",
  }));
}

export function buildApprovalEvidence(items: ReadonlyArray<Approval>): EvidenceItem[] {
  return items.map((approval) => ({
    id: `appr:${approval.id}`,
    kind: "approval",
    title: `Approval · ${approval.type}`,
    summary: safeDisplayText(approval.decisionNote ?? null),
    timestamp: toIsoString(approval.decidedAt) ?? toIsoString(approval.updatedAt) ?? toIsoString(approval.createdAt),
    actor: approval.decidedByUserId ? `user:${approval.decidedByUserId}` : null,
    truthLabel: "backend-backed",
    state: approval.status,
    sourceLabel: "Approval",
  }));
}

export function buildInteractionEvidence(
  items: ReadonlyArray<IssueThreadInteraction>,
): EvidenceItem[] {
  return items.map((interaction) => {
    if (interaction.kind === "final_delivery") {
      const dest = interaction.payload?.destination;
      const masked = dest ? maskFinalDeliveryDestination(dest) : "destination redacted";
      const result = interaction.result;
      const error = result?.error ? safeDisplayText(result.error) : null;
      const summaryParts: string[] = [masked];
      if (result?.outcome) summaryParts.push(result.outcome);
      if (error) summaryParts.push(error);
      return {
        id: `int:${interaction.id}`,
        kind: "final_delivery",
        title: interaction.title ?? "Final delivery",
        summary: summaryParts.join(" · "),
        timestamp:
          toIsoString(interaction.resolvedAt) ?? toIsoString(interaction.updatedAt) ?? toIsoString(interaction.createdAt),
        actor: null,
        truthLabel: "backend-backed",
        state: result?.outcome ?? interaction.status,
        sourceLabel: "Final delivery",
      };
    }
    return {
      id: `int:${interaction.id}`,
      kind: "interaction",
      title: interaction.title ?? `Interaction · ${interaction.kind}`,
      summary: safeDisplayText(interaction.summary ?? null),
      timestamp:
        toIsoString(interaction.resolvedAt) ?? toIsoString(interaction.updatedAt) ?? toIsoString(interaction.createdAt),
      actor: null,
      truthLabel: "backend-backed",
      state: interaction.status,
      sourceLabel: "Interaction",
    };
  });
}

export function buildRunEvidence(items: ReadonlyArray<RunForIssue>): EvidenceItem[] {
  return items.map((run) => ({
    id: `run:${run.runId}`,
    kind: "run",
    title: `Run · ${run.agentId.slice(0, 8)}`,
    summary: safeDisplayText(run.nextAction ?? run.livenessReason ?? null),
    timestamp: run.finishedAt ?? run.startedAt ?? run.createdAt,
    actor: `agent:${run.agentId}`,
    truthLabel: "backend-backed",
    state: run.status,
    sourceLabel: "Run",
  }));
}

export function buildLiveRunEvidence(
  liveRuns: ReadonlyArray<LiveRunForIssue>,
  active: ActiveRunForIssue | null | undefined,
): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  if (active) {
    seen.add(active.id);
    out.push({
      id: `live:${active.id}`,
      kind: "live_run",
      title: `Live run · ${active.agentName}`,
      summary: safeDisplayText(active.nextAction ?? active.livenessReason ?? null),
      timestamp: toIsoString(active.finishedAt) ?? toIsoString(active.startedAt) ?? toIsoString(active.createdAt),
      actor: `agent:${active.agentId}`,
      truthLabel: "backend-backed",
      state: active.status,
      sourceLabel: "Active run",
    });
  }
  for (const run of liveRuns) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    out.push({
      id: `live:${run.id}`,
      kind: "live_run",
      title: `Live run · ${run.agentName}`,
      summary: safeDisplayText(run.nextAction ?? run.livenessReason ?? null),
      timestamp: run.finishedAt ?? run.startedAt ?? run.createdAt,
      actor: `agent:${run.agentId}`,
      truthLabel: "backend-backed",
      state: run.status,
      sourceLabel: "Live run",
    });
  }
  return out;
}

export function buildCommentEvidence(items: ReadonlyArray<IssueComment>, limit = 20): EvidenceItem[] {
  return items.slice(0, limit).map((comment) => ({
    id: `cmt:${comment.id}`,
    kind: "comment",
    title:
      comment.presentation?.title
      ?? (comment.authorType === "agent"
        ? "Agent comment"
        : comment.authorType === "user"
          ? "User comment"
          : "System comment"),
    summary: safeDisplayText(comment.body),
    timestamp: toIsoString(comment.createdAt),
    actor: comment.authorAgentId
      ? `agent:${comment.authorAgentId}`
      : comment.authorUserId
        ? `user:${comment.authorUserId}`
        : `system`,
    truthLabel: "backend-backed",
    state: null,
    sourceLabel: comment.authorType === "system" ? "System note" : "Comment",
  }));
}

export function buildTreeEventEvidence(tree: IssueTreeObservability | undefined | null, limit = 20): EvidenceItem[] {
  if (!tree) return [];
  return tree.timeline.slice(0, limit).map((entry) => ({
    id: `tree:${entry.id}`,
    kind: "tree_event",
    title: entry.label,
    summary: safeDisplayText(entry.message ?? null),
    timestamp: toIsoString(entry.timestamp),
    actor: null,
    truthLabel: "backend-backed",
    state: `${entry.kind}/${entry.severity}`,
    sourceLabel: "Tree event",
  }));
}

export interface BuildEvidenceInput {
  documents?: ReadonlyArray<IssueDocumentSummary> | null;
  workProducts?: ReadonlyArray<IssueWorkProduct> | null;
  validation?: IssueValidationHistory | null;
  approvals?: ReadonlyArray<Approval> | null;
  interactions?: ReadonlyArray<IssueThreadInteraction> | null;
  runs?: ReadonlyArray<RunForIssue> | null;
  liveRuns?: ReadonlyArray<LiveRunForIssue> | null;
  activeRun?: ActiveRunForIssue | null;
  comments?: ReadonlyArray<IssueComment> | null;
  treeObservability?: IssueTreeObservability | null;
}

export function buildEvidenceItems(input: BuildEvidenceInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  items.push(...buildDocumentEvidence(input.documents ?? []));
  items.push(...buildWorkProductEvidence(input.workProducts ?? []));
  items.push(...buildValidationEvidence(input.validation ?? null));
  items.push(...buildApprovalEvidence(input.approvals ?? []));
  items.push(...buildInteractionEvidence(input.interactions ?? []));
  items.push(...buildLiveRunEvidence(input.liveRuns ?? [], input.activeRun ?? null));
  items.push(...buildRunEvidence(input.runs ?? []));
  items.push(...buildCommentEvidence(input.comments ?? []));
  items.push(...buildTreeEventEvidence(input.treeObservability ?? null));
  items.sort((a, b) => {
    const am = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bm = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bm - am;
  });
  return items;
}
