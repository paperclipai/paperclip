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

/**
 * The view switch on the classic Decisions page and Coordinator Needs You
 * (PAP-749 plan §1, Rule 3; §3). "For you" is the default; the URL keeps the
 * others so a link (and the Unassigned banner) can open them directly.
 * Archived holds the cards you archived or snoozed for yourself.
 */
export const ATTENTION_VIEW_LABELS: Record<AttentionPersonalView, string> = {
  mine: "For you",
  unassigned: "Unassigned",
  company: "Company",
  archived: "Archived",
};

export const ATTENTION_VIEW_PARAM = "view";

export function parseAttentionView(value: string | null | undefined): AttentionPersonalView {
  return (ATTENTION_PERSONAL_VIEWS as readonly string[]).includes(value ?? "")
    ? value as AttentionPersonalView
    : "mine";
}

export const EMPTY_ATTENTION_VIEW_COUNTS: AttentionViewCounts = { mine: 0, unassigned: 0, company: 0, archived: 0 };

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
