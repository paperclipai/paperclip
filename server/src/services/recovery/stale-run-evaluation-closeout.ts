/**
 * Close-out rule for `stale_active_run_evaluation` cards whose origin run is already terminal.
 *
 * The watchdog that raises these cards answers a question about a *live* run: "is this run
 * still producing output?". Once the origin run reaches a terminal status the question is
 * moot - there is nothing left to review, nothing to cancel, and no output to recover.
 *
 * Before this rule existed, every such card had to be hand-closed by a human. The class had
 * been raised 226 times and hand-closed 226 times, always with the same answer (TON-927).
 *
 * This module holds the *decision* logic as pure functions so it can be tested without a
 * database; the database side lives in `recovery/service.ts`.
 */

/**
 * Marker embedded in the auto-close comment. Text carrying this marker is excluded from the
 * recovery-request scan, so the rule's own comment can never make a card look like it is
 * asking for artifact recovery.
 */
export const STALE_RUN_EVALUATION_AUTO_CLOSE_MARKER = "stale-run-evaluation:auto-close";

/**
 * Terminal run statuses. Mirrors `TERMINAL_HEARTBEAT_RUN_STATUSES` from `services/issues.ts`
 * but is kept local so this module stays dependency-free (and therefore cheap to unit test).
 */
export const TERMINAL_STALE_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Phrases that ask for work to be redone or fetched again.
 *
 * A card is only auto-closed when such a phrase is attached to an artifact noun, and even
 * then only when it is a *request* rather than a statement that nothing needs doing.
 */
const RECOVER_ACTION_PATTERN =
  /\b(?:recover|replay|resume|rerun|re-run|refetch|re-fetch|reconstruct|reproduce|resubmit|re-submit)\w*/i;

/**
 * The nouns that make a recovery action meaningful. "recover" on its own is ambiguous
 * ("recover from the failure"); "recover the output" is not.
 */
const ARTIFACT_PATTERN =
  /\b(?:artifact|artifacts|output|outputs|log|logs|ndjson|transcript|transcripts|stdout|stderr|session|sessions|payload|file|files)\b/i;

/**
 * Negations that turn a recovery phrase into a statement that NO recovery is needed.
 * "nothing to recover", "no artifacts to recover", "no output was lost" must not be
 * mistaken for a recovery request - that is exactly the wording the hand-closed cards used.
 */
const NEGATION_PATTERN =
  /\b(?:no|nothing|none|never|without|neither|nor|isn't|wasn't|aren't|weren't|don't|doesn't|didn't|cannot|can't|no longer)\b[^.\n]{0,40}$/i;

/**
 * True when the text asks for artifact / output recovery.
 *
 * The check is deliberately conservative: it errs towards "this card needs a human" rather
 * than towards auto-closing a card someone is actually working.
 */
export function requestsArtifactRecovery(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.includes(STALE_RUN_EVALUATION_AUTO_CLOSE_MARKER)) return false;

  // Split into sentences so a negation in one sentence does not disarm a request in another,
  // and a negation does not leak backwards across a sentence boundary.
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    const action = RECOVER_ACTION_PATTERN.exec(sentence);
    const artifact = ARTIFACT_PATTERN.exec(sentence);
    if (!action || !artifact) continue;
    // The negation must appear BEFORE the recovery phrase to disarm it ("nothing to recover").
    const prefix = sentence.slice(0, action.index);
    if (NEGATION_PATTERN.test(prefix)) continue;
    return true;
  }
  return false;
}

export interface StaleRunEvaluationCloseoutDecision {
  /** Whether the card should be auto-closed. */
  close: boolean;
  /** Machine-readable reason code, stable for assertions and for the recorded comment. */
  reason:
    | "terminal_origin_run"
    | "origin_run_missing"
    | "origin_run_still_active"
    | "card_already_closed"
    | "card_actively_worked"
    | "card_has_pending_interaction"
    | "recovery_requested";
  /** Human-readable explanation recorded on the card. */
  detail: string;
}

export interface StaleRunEvaluationCloseoutInput {
  /** Card status. */
  cardStatus: string;
  /** Origin run status, or null when the origin run row no longer exists. */
  runStatus: string | null;
  /** True when the card's own execution run is still live (an agent is working it). */
  cardHasLiveExecution: boolean;
  /** True when a thread interaction on the card is still waiting for a human answer. */
  cardHasPendingInteraction?: boolean;
  /** The card description plus every comment on it, oldest first. */
  texts?: Array<string | null | undefined>;
}

/**
 * Decide whether a stale-run evaluation card can be auto-closed.
 *
 * The card is auto-closed when, and only when, all of the following hold:
 * - the card is still open;
 * - its origin run exists and has reached a terminal status;
 * - no agent is actively working the card (no live execution run);
 * - nothing in the card's text asks for artifact / output recovery.
 */
export function decideStaleRunEvaluationCloseout(
  input: StaleRunEvaluationCloseoutInput,
): StaleRunEvaluationCloseoutDecision {
  if (input.cardStatus === "done" || input.cardStatus === "cancelled") {
    return { close: false, reason: "card_already_closed", detail: "Card is already closed." };
  }
  if (!input.runStatus) {
    return {
      close: false,
      reason: "origin_run_missing",
      detail: "The origin run row no longer exists; a human should confirm what happened before this card is closed.",
    };
  }
  if (!TERMINAL_STALE_RUN_STATUSES.has(input.runStatus)) {
    return {
      close: false,
      reason: "origin_run_still_active",
      detail: `The origin run is still active (status \`${input.runStatus}\`); this card is a live review, not noise.`,
    };
  }
  if (input.cardHasLiveExecution) {
    return {
      close: false,
      reason: "card_actively_worked",
      detail: "An agent is actively working this card; leaving the disposition to that agent.",
    };
  }
  if (input.cardHasPendingInteraction) {
    return {
      close: false,
      reason: "card_has_pending_interaction",
      detail:
        "A question or confirmation is still open on this card, so a human is waiting to answer it; closing it now would drop that request on the floor.",
    };
  }
  for (const text of input.texts ?? []) {
    if (requestsArtifactRecovery(text)) {
      return {
        close: false,
        reason: "recovery_requested",
        detail:
          "This card asks for artifact or output recovery, so it is not noise and must not be auto-closed.",
      };
    }
  }
  return {
    close: true,
    reason: "terminal_origin_run",
    detail: `The origin run reached a terminal status (\`${input.runStatus}\`), so the silence assessment no longer applies: there is nothing left to cancel, watch, or recover from this run.`,
  };
}
