import type { AttentionItem } from "@paperclipai/shared";
import { attentionDetailLine, sourceMeta } from "./attention";

/**
 * One card for each obligation (PAP-749 plan §2, Rule 11). The server keeps
 * every card and marks the ones that are one obligation with a shared
 * `obligationKey` and the id of the lead card; the page shows the lead and
 * folds the others into it as evidence.
 */
export interface FoldedAttentionObligations {
  /** The cards to show: each lead, each card that is its own obligation, and evidence whose lead is not in the list. */
  cards: AttentionItem[];
  /** The evidence cards folded into each shown lead, keyed by the lead's `id`. */
  evidenceByLeadId: ReadonlyMap<string, AttentionItem[]>;
}

const NO_EVIDENCE: readonly AttentionItem[] = [];

export function isAttentionObligationEvidence(item: AttentionItem): boolean {
  return item.obligationLeadId != null && item.obligationLeadId !== item.id;
}

/**
 * Fold evidence into its lead. An evidence card whose lead is not in `items`
 * stays a card of its own, so nothing of the obligation disappears.
 */
export function foldAttentionObligations(items: readonly AttentionItem[]): FoldedAttentionObligations {
  const ids = new Set(items.map((item) => item.id));
  const cards: AttentionItem[] = [];
  const evidenceByLeadId = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (isAttentionObligationEvidence(item) && ids.has(item.obligationLeadId!)) {
      const evidence = evidenceByLeadId.get(item.obligationLeadId!);
      if (evidence) evidence.push(item);
      else evidenceByLeadId.set(item.obligationLeadId!, [item]);
    } else {
      cards.push(item);
    }
  }
  return { cards, evidenceByLeadId };
}

export function attentionObligationEvidence(
  folded: FoldedAttentionObligations,
  item: AttentionItem,
): readonly AttentionItem[] {
  return folded.evidenceByLeadId.get(item.id) ?? NO_EVIDENCE;
}

/** The task rows a provider-limit card represents in the inbox toolbar. */
function inboxCardMembers(folded: FoldedAttentionObligations, item: AttentionItem) {
  return item.providerLimit ? [item, ...attentionObligationEvidence(folded, item)] : [item];
}

export function inboxProjectOptions(folded: FoldedAttentionObligations, cards: readonly AttentionItem[],
  receipts: readonly { projectId: string | null; projectName: string | null }[]) {
  const projects = new Map<string, string>();
  for (const card of cards) {
    for (const member of inboxCardMembers(folded, card)) {
      const project = member.project;
      if (project) projects.set(project.id, project.name);
    }
  }
  for (const receipt of receipts) {
    if (receipt.projectId) projects.set(receipt.projectId, receipt.projectName ?? "Unnamed project");
  }
  return [...projects.entries()];
}

export function inboxCardMatchesFilters(folded: FoldedAttentionObligations, item: AttentionItem,
  filters: { query: string; agentId: string; agentName?: string; projectId: string }) {
  const query = filters.query.trim().toLocaleLowerCase();
  return inboxCardMembers(folded, item).some(member => {
    if (filters.projectId && member.project?.id !== filters.projectId) return false;
    const agentId = member.providerLimit?.agentId ?? member.subject.metadata?.createdByAgentId ?? member.subject.metadata?.originAgentId;
    if (filters.agentId && agentId !== filters.agentId
      && (agentId || !filters.agentName || member.originAgentName !== filters.agentName)) return false;
    if (!query) return true;
    return [member.subject.title, member.relatedIssue?.title, member.relatedIssue?.identifier, member.originAgentName,
      member.providerLimit?.agentName, member.project?.name, attentionDetailLine(member)].join(" ").toLocaleLowerCase().includes(query);
  });
}

/**
 * What an evidence card is to its lead: the task that waits on the approval,
 * the work a failed run blocks, or another cause.
 */
export function attentionEvidenceLabel(lead: AttentionItem, evidence: AttentionItem): string {
  if (evidence.sourceKind === "review") return lead.sourceKind === "approval" ? "Task waiting on this approval" : "Task in review";
  if (evidence.sourceKind === "blocker_attention") return lead.sourceKind === "failed_run" ? "Blocked by this run" : "Blocked work";
  if (evidence.sourceKind === "failed_run") return "Also failed";
  // Raise limit approves the override approval and Keep paused rejects it (PAP-768).
  if (evidence.sourceKind === "approval" && lead.sourceKind === "budget_alert") return "Approval this answers";
  return sourceMeta(evidence.sourceKind).label;
}

/** The one line an evidence card adds: what it is about and what it says. */
export function attentionEvidenceText(evidence: AttentionItem): { title: string; detail: string | null } {
  const subject = evidence.subject;
  const title = [subject.identifier, subject.title].filter(Boolean).join(" ") || sourceMeta(evidence.sourceKind).label;
  const detail = attentionDetailLine(evidence) ?? evidence.whyNow;
  return { title, detail: detail && detail !== subject.title ? detail : null };
}

/**
 * The evidence a card still needs to show. A human unblock card already says
 * what its task holds up, so the stalled-chain card for that same task would
 * only repeat it.
 */
export function attentionEvidenceToShow(lead: AttentionItem, evidence: readonly AttentionItem[]): readonly AttentionItem[] {
  const leadIsHumanUnblock = lead.sourceKind === "blocker_attention" && lead.detail?.kind === "blocker" && Boolean(lead.detail.unblockAction);
  if (!leadIsHumanUnblock) return evidence;
  return evidence.filter((entry) => !(entry.sourceKind === "blocker_attention" && entry.subject.id === lead.subject.id));
}
