import type { IssueThreadInteraction } from "./issue-thread-interactions";

/**
 * RBR-914 (AC4 of RBR-893). Presentation-only model for the multi-pending-confirmation hazard.
 *
 * Background. RBR-823 reported that one board comment expired *every* pending interaction on an
 * issue, so contradictory irreversible asks were silently garbage-collected together. RBR-852 and
 * RBR-875 fixed that on the server: expiry-by-comment is opt-in, an explicit
 * `supersedesInteractionIds` link retires named asks at create time, and when a comment matches
 * more than one supersedable candidate the server deliberately expires **nothing** rather than
 * guessing which ask the comment answered (RBR-852 AC1).
 *
 * The consequence of not guessing is that contradictory confirmations can legitimately coexist.
 * RBR-893 AC3 made the server *say so* — but only into a `console.warn` that no board member ever
 * reads. This module is the read-only derivation behind the UI that finally shows it, so the board
 * can see which ask is newest, what a prose reply will actually do, and which ask replaced which.
 *
 * Hard constraint from the issue: **no server semantics change**. Everything here is derived from
 * interaction rows the thread already has. Nothing in this file expires, resolves, orders, or
 * mutates anything; it decides only what to render. The kind sets below mirror the server's
 * (`REQUEST_CONFIRMATION_INTERACTION_KINDS` / `USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS` in
 * `server/src/services/issue-thread-interactions.ts`) so the warning we show matches the rule the
 * server will actually apply. If they drift, the UI becomes dishonest — keep them in step.
 */

/** Mirrors the server's `REQUEST_CONFIRMATION_INTERACTION_KINDS`. */
export const CONFIRMATION_LIKE_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;

/** Mirrors the server's `USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS`. */
export const USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS = [
  ...CONFIRMATION_LIKE_INTERACTION_KINDS,
  "request_item_verdicts",
  "ask_user_questions",
] as const;

export function isConfirmationLikeInteraction(interaction: IssueThreadInteraction): boolean {
  return (CONFIRMATION_LIKE_INTERACTION_KINDS as readonly string[]).includes(interaction.kind);
}

export function isUserCommentSupersedableInteraction(interaction: IssueThreadInteraction): boolean {
  return (USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS as readonly string[]).includes(interaction.kind);
}

/**
 * Whether a plain board comment is permitted to expire this ask at all. Post-RBR-875 this is
 * strictly opt-in: the payload must carry `supersedeOnUserComment: true`.
 */
export function isOptedIntoCommentSupersession(interaction: IssueThreadInteraction): boolean {
  if (!isUserCommentSupersedableInteraction(interaction)) return false;
  const payload = interaction.payload as { supersedeOnUserComment?: unknown } | null | undefined;
  return payload?.supersedeOnUserComment === true;
}

function declaredSupersedesIds(interaction: IssueThreadInteraction): string[] {
  const payload = interaction.payload as { supersedesInteractionIds?: unknown } | null | undefined;
  const ids = payload?.supersedesInteractionIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function declaredSupersededById(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result as { supersededByInteractionId?: unknown } | null | undefined;
  const id = result?.supersededByInteractionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function createdAtMs(interaction: IssueThreadInteraction): number {
  const value = interaction.createdAt;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Newest first. Ties broken on id (descending) purely so the render order is deterministic — a tie
 * is reported as ambiguous rather than silently resolved, see {@link PendingConfirmationHazard}.
 */
function byNewestFirst(a: IssueThreadInteraction, b: IssueThreadInteraction): number {
  const delta = createdAtMs(b) - createdAtMs(a);
  if (delta !== 0) return delta;
  return b.id.localeCompare(a.id);
}

/**
 * What a plain prose comment will actually do to the pending asks on this thread (AC2).
 *
 * - `expires_one` — exactly one pending supersedable ask is opted in, so a comment silently
 *   expires *that* one and leaves the rest. This is the dangerous case: prose looks like an
 *   answer to whichever card the reader had in mind, and the server will apply it to a different
 *   one.
 * - `expires_none_multiple_optins` — two or more are opted in, so the server refuses to guess and
 *   expires nothing. Safe for the data, still misleading for the human: the prose answers nothing
 *   and every ask stays pending.
 * - `expires_none` — nothing is opted in, so a comment cannot expire anything.
 */
export type ProseAnswerRisk = "expires_one" | "expires_none_multiple_optins" | "expires_none";

export interface PendingConfirmationHazard {
  /** Every pending confirmation-like ask on the thread, newest first. Always length >= 2. */
  pending: readonly IssueThreadInteraction[];
  /** Id of the newest pending confirmation-like ask (AC1). */
  newestId: string;
  /**
   * True when the two newest pending asks share an identical `createdAt`, so "newest" cannot be
   * established from the data. We say that rather than picking a winner — guessing a winner is the
   * defect RBR-823 reported.
   */
  newestIsAmbiguous: boolean;
  /** What a prose reply will do (AC2). */
  proseRisk: ProseAnswerRisk;
  /**
   * Pending supersedable asks (any kind, not just confirmations) whose payload opted in to
   * expiry-by-comment — the rows a prose reply can actually retire.
   */
  proseOptedIn: readonly IssueThreadInteraction[];
}

/**
 * Build the hazard for a thread, or `null` when there is none. The hazard exists only when more
 * than one confirmation-like ask is pending at the same time — a single pending ask is the normal
 * case and gets no warning furniture.
 */
export function buildPendingConfirmationHazard(
  interactions: readonly IssueThreadInteraction[],
): PendingConfirmationHazard | null {
  const pendingConfirmations = interactions
    .filter((interaction) => interaction.status === "pending" && isConfirmationLikeInteraction(interaction))
    .sort(byNewestFirst);
  if (pendingConfirmations.length < 2) return null;

  const proseOptedIn = interactions
    .filter((interaction) => interaction.status === "pending" && isOptedIntoCommentSupersession(interaction))
    .sort(byNewestFirst);
  const proseRisk: ProseAnswerRisk = proseOptedIn.length === 1
    ? "expires_one"
    : proseOptedIn.length > 1
      ? "expires_none_multiple_optins"
      : "expires_none";

  return {
    pending: pendingConfirmations,
    newestId: pendingConfirmations[0]!.id,
    newestIsAmbiguous: createdAtMs(pendingConfirmations[0]!) === createdAtMs(pendingConfirmations[1]!),
    proseRisk,
    proseOptedIn,
  };
}

export interface InteractionHazardPlacement {
  hazard: PendingConfirmationHazard;
  /** This interaction is the newest pending confirmation-like ask on the thread. */
  isNewest: boolean;
  /** 1-based position, newest = 1. */
  position: number;
  /** Total pending confirmation-like asks, including this one. */
  total: number;
  /** The other pending confirmation-like asks, newest first. */
  others: readonly IssueThreadInteraction[];
}

/**
 * Where a specific card sits inside the thread hazard, or `null` when this card is not one of
 * several coexisting pending confirmations (the overwhelmingly common case).
 */
export function pendingConfirmationHazardPlacement(
  interaction: IssueThreadInteraction,
  interactions: readonly IssueThreadInteraction[],
): InteractionHazardPlacement | null {
  const hazard = buildPendingConfirmationHazard(interactions);
  if (!hazard) return null;
  const index = hazard.pending.findIndex((candidate) => candidate.id === interaction.id);
  if (index < 0) return null;
  return {
    hazard,
    isNewest: !hazard.newestIsAmbiguous && index === 0,
    position: index + 1,
    total: hazard.pending.length,
    others: hazard.pending.filter((candidate) => candidate.id !== interaction.id),
  };
}

/**
 * AC2 copy. Stated as what the server will do, not as vague caution — a warning the reader cannot
 * act on is the same as no warning.
 */
export function proseAnswerWarning(hazard: PendingConfirmationHazard): string {
  const count = hazard.pending.length;
  const lead = `${count} confirmations are pending on this task at once.`;
  switch (hazard.proseRisk) {
    case "expires_one":
      return `${lead} Answering in a plain comment is not a safe way to answer one of them: exactly one of the pending asks opted in to expiry-by-comment, so your comment will expire that ask — not necessarily the one you meant — and leave the others pending. Use the buttons on the specific card instead.`;
    case "expires_none_multiple_optins":
      return `${lead} More than one opted in to expiry-by-comment, so a plain comment expires none of them rather than guessing which ask it answered. Your prose will not be recorded as an answer to any card. Use the buttons on the specific card instead.`;
    case "expires_none":
      return `${lead} None of them can be answered by a plain comment, so prose will leave every ask pending. Use the buttons on the specific card you mean to answer.`;
  }
}

export interface SupersessionPointer {
  id: string;
  /** Human label for the target, or `null` when the target is not in this thread's payload. */
  label: string | null;
  /** Status of the target when it is present in the thread. */
  status: IssueThreadInteraction["status"] | null;
  /** In-thread anchor when the target is on this thread; `null` when it is not loaded here. */
  href: string | null;
}

export interface SupersessionPointers {
  /** Asks this interaction explicitly declared it replaces (`payload.supersedesInteractionIds`). */
  replaces: readonly SupersessionPointer[];
  /** The ask that replaced this one (`result.supersededByInteractionId`). */
  replacedBy: SupersessionPointer | null;
}

function interactionRefLabel(interaction: IssueThreadInteraction): string {
  const title = interaction.title?.trim();
  if (title) return title;
  switch (interaction.kind) {
    case "request_confirmation":
      return "Confirmation request";
    case "request_checkbox_confirmation":
      return "Checkbox confirmation request";
    case "request_item_verdicts":
      return "Item review request";
    case "ask_user_questions":
      return "Question request";
    case "suggest_tasks":
      return "Suggested tasks";
    default:
      return "Interaction";
  }
}

function buildPointer(
  id: string,
  byId: ReadonlyMap<string, IssueThreadInteraction>,
): SupersessionPointer {
  const target = byId.get(id);
  if (!target) {
    // Cross-issue links are legal server-side (same company), so a named target genuinely may not
    // be in this thread. Say "not on this task" rather than rendering a dead anchor.
    return { id, label: null, status: null, href: null };
  }
  return {
    id,
    label: interactionRefLabel(target),
    status: target.status,
    href: `#interaction-${target.id}`,
  };
}

/**
 * AC3. Surface the explicit pointer relationship both ways, so the reader is never left diffing
 * two payloads by eye to work out that one ask replaced another.
 */
export function buildSupersessionPointers(
  interaction: IssueThreadInteraction,
  interactions: readonly IssueThreadInteraction[],
): SupersessionPointers | null {
  const replacesIds = declaredSupersedesIds(interaction);
  const replacedById = declaredSupersededById(interaction);
  if (replacesIds.length === 0 && !replacedById) return null;
  const byId = new Map(interactions.map((entry) => [entry.id, entry] as const));
  return {
    replaces: replacesIds.map((id) => buildPointer(id, byId)),
    replacedBy: replacedById ? buildPointer(replacedById, byId) : null,
  };
}
