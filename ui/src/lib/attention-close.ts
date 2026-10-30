import {
  ATTENTION_CLAIMABLE_SOURCE_KINDS,
  attentionStaleReasonText,
  type AttentionAlreadyClosedDetails,
  type AttentionCloseMode,
  type AttentionItem,
} from "@paperclipai/shared";

/**
 * The Close… menu (PAP-749 plan §2, Rule 6) and the Stale group (§3). Pure
 * helpers so both Decisions pages make the same choices. The server still
 * checks every close, claim and transfer; nothing here grants authority.
 */

/**
 * The Close… verbs the server listed for this card. A feed from a server
 * without `closeModes` (an older cached response) offers none.
 */
export function attentionCloseModes(item: AttentionItem): readonly AttentionCloseMode[] {
  return item.closeModes ?? [];
}

/** Withdraw closes the request for everyone; only some sources have one. */
export function attentionCanWithdraw(item: AttentionItem): boolean {
  return attentionCloseModes(item).includes("withdraw");
}

/** Transfer stores a new addressee, so it needs a source with that field. */
export function attentionCanTransfer(item: AttentionItem): boolean {
  return (ATTENTION_CLAIMABLE_SOURCE_KINDS as readonly string[]).includes(item.sourceKind);
}

/**
 * The person a card is for, when that is not the viewer. Acting on such a card
 * asks "This is for @x. Continue?" first (PAP-749 plan §2 and §6).
 */
export function attentionOtherAudienceUserId(
  item: AttentionItem,
  currentUserId: string | null | undefined,
): string | null {
  const audience = item.audience;
  if (!audience || audience.kind !== "user" || !audience.userId) return null;
  return audience.userId === currentUserId ? null : audience.userId;
}

export function attentionUserLabel(
  userId: string,
  userLabelMap: ReadonlyMap<string, string> | null | undefined,
): string {
  return userLabelMap?.get(userId) ?? "another person";
}

/** People the card can go to: everyone in the directory but the viewer and the current owner. */
export function attentionTransferTargets(
  item: AttentionItem,
  currentUserId: string | null | undefined,
  userLabelMap: ReadonlyMap<string, string> | null | undefined,
): Array<{ userId: string; label: string }> {
  if (!attentionCanTransfer(item) || !userLabelMap) return [];
  const owner = item.audience?.kind === "user" ? item.audience.userId : null;
  return [...userLabelMap]
    .filter(([userId]) => userId !== currentUserId && userId !== owner)
    .map(([userId, label]) => ({ userId, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * How a card in the Archived view is hidden for you (PAP-749 plan §3):
 * archived until it changes, or snoozed until a time. `null` for a card you
 * did not hide.
 */
export type AttentionHiddenState =
  | { kind: "archived"; since: string }
  | { kind: "snoozed"; since: string; until: string };

export function attentionHiddenState(item: AttentionItem): AttentionHiddenState | null {
  const dismissal = item.dismissal;
  if (!dismissal?.isActive) return null;
  if (dismissal.kind === "snooze" && dismissal.snoozedUntil) {
    return { kind: "snoozed", since: dismissal.dismissedAt, until: dismissal.snoozedUntil };
  }
  return { kind: "archived", since: dismissal.dismissedAt };
}

/** "Archived Oct 29" or "Back Fri, Oct 31, 9:00 AM" (local time). */
export function attentionHiddenText(hidden: AttentionHiddenState): string {
  if (hidden.kind === "snoozed") {
    return `Back ${new Date(hidden.until).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return `Archived ${new Date(hidden.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * The Archived view's two parts: archived cards first, then the Snoozed group,
 * which comes back soonest first.
 */
export function splitArchivedAttentionItems(items: AttentionItem[]): {
  archived: AttentionItem[];
  snoozed: AttentionItem[];
} {
  const archived: AttentionItem[] = [];
  const snoozed: AttentionItem[] = [];
  for (const item of items) (attentionHiddenState(item)?.kind === "snoozed" ? snoozed : archived).push(item);
  snoozed.sort((a, b) => Date.parse(a.dismissal!.snoozedUntil!) - Date.parse(b.dismissal!.snoozedUntil!));
  return { archived, snoozed };
}

/** Current cards first; stale cards go to the collapsed Stale (N) group (Rule 10). */
export function splitStaleAttentionItems(items: AttentionItem[]): {
  current: AttentionItem[];
  stale: AttentionItem[];
} {
  const current: AttentionItem[] = [];
  const stale: AttentionItem[] = [];
  for (const item of items) (item.stale ? stale : current).push(item);
  return { current, stale };
}

/**
 * What "Withdraw all stale" does (PAP-749 plan §2, Rule 10). It withdraws only
 * cards with a real withdraw that are not required gates. Required approvals
 * and governed requests go to a person and never leave in bulk; a person can
 * still withdraw one from its own Close… menu. Cards with no request to
 * withdraw (failed runs, reviews, budget) also stay. The confirmation lists
 * all three, so nothing closes without the person seeing it.
 */
export function planStaleWithdraw(items: AttentionItem[]): {
  withdrawable: AttentionItem[];
  required: AttentionItem[];
  kept: AttentionItem[];
} {
  const withdrawable: AttentionItem[] = [];
  const required: AttentionItem[] = [];
  const kept: AttentionItem[] = [];
  for (const item of items) {
    if (!attentionCanWithdraw(item)) kept.push(item);
    else if (item.required) required.push(item);
    else withdrawable.push(item);
  }
  return { withdrawable, required, kept };
}

export function attentionStaleChipText(item: AttentionItem): string | null {
  return item.stale ? attentionStaleReasonText(item.stale.reason) : null;
}

/** The 409 the close, claim and transfer endpoints send when someone else was first. */
export function readAttentionAlreadyClosed(error: unknown): AttentionAlreadyClosedDetails | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const details = (body as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  return (details as { code?: unknown }).code === "attention_already_closed"
    ? details as AttentionAlreadyClosedDetails
    : null;
}

/** "Already answered by @x" (PAP-749 plan §2, "Two persons answer at the same time"). */
export function attentionAlreadyClosedText(
  details: AttentionAlreadyClosedDetails,
  userLabelMap: ReadonlyMap<string, string> | null | undefined,
): string {
  if (details.resolvedByUserId) return `Already answered by @${attentionUserLabel(details.resolvedByUserId, userLabelMap)}`;
  return details.resolvedByAgentId ? "Already answered by an agent" : "Already answered";
}

export function attentionForOtherText(name: string, verb: "withdraw" | "continue"): string {
  return verb === "withdraw" ? `This is for @${name}. Withdraw anyway?` : `This is for @${name}. Continue?`;
}
