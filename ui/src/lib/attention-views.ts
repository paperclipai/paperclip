import {
  ATTENTION_CLAIMABLE_SOURCE_KINDS,
  ATTENTION_PERSONAL_VIEWS,
  attentionAudienceReasonText,
  attentionReceiptText,
  type AttentionItem,
  type AttentionPersonalView,
  type AttentionReceipt,
  type AttentionViewCounts,
} from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";

/**
 * The view switch on the classic Decisions page and Coordinator Needs You
 * (PAP-749 plan §1, Rule 3; §3). "For you" is the default; the URL keeps the
 * others so a link (and the Unassigned banner) can open them directly.
 * Archived holds the cards you archived or snoozed for yourself. Everyone
 * holds every person's cards, for board members only (PAP-768).
 */
export const ATTENTION_VIEW_LABELS: Record<AttentionPersonalView, string> = {
  mine: "For you",
  unassigned: "Unassigned",
  company: "Company",
  archived: "Archived",
  all: "Everyone",
};

export const ATTENTION_VIEW_PARAM = "view";

/** The views a person can switch to: Everyone only for a board member. */
export function attentionViewsFor(everyone: boolean): readonly AttentionPersonalView[] {
  return everyone ? ATTENTION_PERSONAL_VIEWS : ATTENTION_PERSONAL_VIEWS.filter((view) => view !== "all");
}

/** The view a URL asks for; "For you" when it names a view this person cannot open. */
export function parseAttentionView(value: string | null | undefined, options: { everyone?: boolean } = {}): AttentionPersonalView {
  return (attentionViewsFor(options.everyone === true) as readonly string[]).includes(value ?? "")
    ? value as AttentionPersonalView
    : "mine";
}

export const EMPTY_ATTENTION_VIEW_COUNTS: AttentionViewCounts = { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 };

/**
 * Whether the signed-in person is a board member of `companyId`, who may see
 * Everyone (PAP-768): a local board, an instance admin, or an active member
 * who can act (owner, admin, operator, or a legacy member). A viewer cannot
 * act on another person's card, so the tab stays hidden. False while the
 * access snapshot is unknown. The server still checks every action.
 */
export function attentionEveryoneViewAllowed(
  companyId: string | null | undefined,
  boardAccess: Pick<CurrentBoardAccess, "source" | "isInstanceAdmin" | "memberships"> | null | undefined,
): boolean {
  if (!boardAccess || !companyId) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  const membership = boardAccess.memberships?.find((entry) => entry.companyId === companyId && entry.status === "active");
  return Boolean(membership?.membershipRole && membership.membershipRole !== "viewer");
}

/** "N cards need an owner" (recommendation e). Never part of the badge. */
export function unassignedBannerText(count: number) {
  return count === 1 ? "1 card needs an owner" : `${count} cards need an owner`;
}

/**
 * What a card says about its audience (PAP-749 plan §1, Rule 4). A card for
 * you says why ("Sent to you"); a card for a different person shows "For
 * @name"; an ownerless card says why you can still answer it and whether you
 * can claim it; a company alert says it is for operators. Placement only: the
 * resolver policy, not this line, decides who may act.
 */
export type AttentionAudienceDescription =
  | { kind: "mine"; text: string; transferredByUserId?: string }
  | { kind: "other"; userId: string }
  | { kind: "pool"; text: string; claimable: boolean }
  | { kind: "company"; text: string; claimable: boolean };

export const ATTENTION_POOL_AUDIENCE_TEXT = "No owner yet. Any board member can answer it.";
export const ATTENTION_COMPANY_AUDIENCE_TEXT = "Company alert for operators";

/**
 * Whether Claim can store an owner for this card. Only sources with an
 * addressee field qualify, and only while nobody owns the card: in the pool,
 * or moved to Company after a week without an owner.
 */
export function attentionItemClaimable(item: AttentionItem): boolean {
  const audience = item.audience;
  if (!audience || audience.userId) return false;
  if (audience.kind !== "pool" && audience.kind !== "company") return false;
  return (ATTENTION_CLAIMABLE_SOURCE_KINDS as readonly string[]).includes(item.sourceKind);
}

/**
 * What an ownerless card offers when Claim cannot store an owner on it
 * (PAP-767): its task, where a person can be assigned, which gives the card
 * that owner. A card with no task (an approval no task waits on) says it
 * cannot be claimed instead of showing nothing. `null` for a claimable card
 * and for a company alert, which nobody owns by design.
 */
export type AttentionClaimAlternative = { kind: "assign"; href: string } | { kind: "none" };

export function attentionClaimAlternative(item: AttentionItem): AttentionClaimAlternative | null {
  const audience = item.audience;
  if (!audience || audience.userId || attentionItemClaimable(item)) return null;
  const unowned = audience.kind === "pool" || (audience.kind === "company" && item.stale?.reason === "unowned");
  if (!unowned) return null;
  const task = item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
  return task?.href ? { kind: "assign", href: task.href } : { kind: "none" };
}

export const ATTENTION_NO_CLAIM_TEXT = "It has no task to assign, so it can't be claimed.";

export function describeAttentionAudience(
  item: AttentionItem,
  currentUserId: string | null | undefined,
): AttentionAudienceDescription | null {
  const audience = item.audience;
  if (!audience) return null;
  if (audience.kind === "user" && audience.userId) {
    if (audience.userId !== currentUserId) return { kind: "other", userId: audience.userId };
    // "Transferred by @x" replaces "Sent to you" (PAP-749 plan §6, Rule 12).
    if (audience.transferredByUserId) {
      return { kind: "mine", text: "Transferred by", transferredByUserId: audience.transferredByUserId };
    }
    const text = attentionAudienceReasonText(audience.reason);
    return text ? { kind: "mine", text } : null;
  }
  if (audience.kind === "pool") {
    return { kind: "pool", text: ATTENTION_POOL_AUDIENCE_TEXT, claimable: attentionItemClaimable(item) };
  }
  return { kind: "company", text: ATTENTION_COMPANY_AUDIENCE_TEXT, claimable: attentionItemClaimable(item) };
}

/**
 * Who may answer an interaction card, worded to agree with its audience line
 * so the two read as one statement (PAP-767): "Why me? You own this project's
 * decisions. Anyone else can answer it too." and "No owner yet. Napping Agent
 * or any board member can answer it." It reads the server-evaluated resolver
 * facts, in the precedence of `describeResolverAudience`. `null` when the
 * card carries no resolver facts: then the plain audience line stands alone.
 */
export function attentionResponderText(
  item: Pick<AttentionItem, "sourceKind" | "resolverAudience">,
  description: AttentionAudienceDescription,
  userLabelMap?: ReadonlyMap<string, string> | null,
): string | null {
  const facts = item.sourceKind === "issue_thread_interaction" ? item.resolverAudience : null;
  if (!facts) return null;
  const mine = description.kind === "mine";
  const too = mine ? " too" : "";
  if (facts.addresseeUserId) {
    if (mine) return "Only you can answer it.";
    return `Only @${userLabelMap?.get(facts.addresseeUserId) ?? "the addressed person"} can answer it.`;
  }
  if (facts.effectiveResolverPolicy === "human_only") return `Any board member can answer it${too}.`;
  if (facts.addresseeAgentId) return `${facts.addresseeName?.trim() || "The addressed agent"} or any board member can answer it${too}.`;
  if (facts.effectiveResolverPolicy === "not_creator") {
    return `Anyone except ${facts.createdByAgentName?.trim() || "the agent that asked"} can answer it${too}.`;
  }
  return mine ? "Anyone else can answer it too." : "Anyone can answer it.";
}

/**
 * The text of an ownerless or company card's audience line, with who may
 * answer it when the card says (PAP-767).
 */
export function attentionUnownedAudienceText(
  item: Pick<AttentionItem, "sourceKind" | "resolverAudience">,
  description: Extract<AttentionAudienceDescription, { kind: "pool" | "company" }>,
  userLabelMap?: ReadonlyMap<string, string> | null,
) {
  const responders = attentionResponderText(item, description, userLabelMap);
  if (!responders) return description.text;
  return description.kind === "pool" ? `No owner yet. ${responders}` : `${description.text}. ${responders}`;
}

/**
 * Whether the card's audience line already says who may answer it, so a row
 * leaves out the separate "Anyone can respond" clause (PAP-767).
 */
export function attentionAudienceLineNamesResponders(item: AttentionItem, currentUserId: string | null | undefined) {
  const description = currentUserId ? describeAttentionAudience(item, currentUserId) : null;
  return Boolean(description && attentionResponderText(item, description));
}

/** Display name for a person on a receipt; never an ID. */
function receiptUserLabel(userId: string | null | undefined, userLabelMap?: ReadonlyMap<string, string> | null) {
  return (userId ? userLabelMap?.get(userId) : null) ?? "someone";
}

/**
 * The first line of a receipt (PAP-749 plan §6, Rule 12): "Answered by
 * @scott", "Withdrawn by @scott", "Transferred to @riley by @scott".
 */
export function attentionReceiptLine(receipt: AttentionReceipt, userLabelMap?: ReadonlyMap<string, string> | null) {
  return attentionReceiptText({
    outcome: receipt.outcome,
    actorLabel: receiptUserLabel(receipt.actorUserId, userLabelMap),
    transferredToLabel: receipt.transferredToUserId ? receiptUserLabel(receipt.transferredToUserId, userLabelMap) : null,
  });
}
