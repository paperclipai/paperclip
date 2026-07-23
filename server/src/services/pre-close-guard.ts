/**
 * §7.10.3 Pre-close guard — structured active-blocker model.
 *
 * QUA-2575: replaces substring-based prose scan with structured state evaluation.
 *
 * Terminal close (done/cancelled) is BLOCKED iff unresolved STRUCTURED state
 * exists in any of these fields:
 *   - open blockedBy relations (unresolvedBlockerCount > 0)
 *   - open child issues (openChildCount > 0)
 *   - pending request_confirmation interaction (hasPendingConfirmation)
 *   - active recovery action (hasActiveRecoveryAction)
 *
 * Prose token scanning is retained as NON-BLOCKING advisory only:
 *   - Matched tokens are surfaced in the pass response for observability.
 *   - guardAcknowledge { tokens, reason } dismisses an advisory and is audit-logged.
 *   - guardAcknowledge NEVER dismisses a structured hard blocker.
 *   - forceTerminal is exception-only (not a routine-close path).
 *
 * Implemented: QUA-2315 (original guard), QUA-2428 (false-positive fixes),
 *              QUA-2575 (structured-blocker model)
 */

export const BUILTIN_GUARD_TOKENS: readonly string[] = [
  "blocked on",
  "awaiting verification",
  "awaiting approval",
  "awaiting confirmation",
  "runtime evidence pending",
  "follow-up filed",
  "should now be resolved",
  "needs verification",
  "pending review",
  "unresolved",
];

/**
 * Strip content excluded from advisory token scanning:
 *   - fenced code blocks (``` … ```)
 *   - inline code (`…`)
 *   - blockquote lines (lines starting with `>`)
 */
export function stripGuardExclusions(text: string): string {
  let result = text.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/`[^`]*`/g, "");
  result = result
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  return result;
}

/** Return tokens that appear (case-insensitive, after exclusion stripping) in text. */
export function findMatchedGuardTokens(
  text: string,
  tokens: readonly string[],
): string[] {
  const stripped = stripGuardExclusions(text).toLowerCase();
  return tokens.filter((token) => stripped.includes(token.toLowerCase()));
}

/** Reasons a structured hard block was triggered. */
export type StructuredBlockerReason =
  | "open_blockedby_links"
  | "open_child_issues"
  | "pending_confirmation"
  | "active_recovery_action";

/** Advisory result from prose token scan — never blocks close. */
export interface AdvisoryResult {
  matchedTokens: string[];
  /** True when all matched tokens are covered by guardAcknowledge. */
  acknowledged: boolean;
  acknowledgedReason?: string;
}

export type GuardDecision =
  | { decision: "pass"; advisory?: AdvisoryResult }
  | { decision: "blocked"; blockedBy: StructuredBlockerReason[] };

/** Structured state inputs — the only source of hard-block truth. */
export interface StructuredBlockerState {
  /** Count of open blockedBy relations (from getDependencyReadiness). */
  unresolvedBlockerCount: number;
  /** Count of non-terminal child issues. */
  openChildCount: number;
  /** True if any request_confirmation interaction is in "pending" status. */
  hasPendingConfirmation: boolean;
  /** True if there is an active recovery action on this issue. */
  hasActiveRecoveryAction: boolean;
}

export interface GuardInput {
  state: StructuredBlockerState;
  /**
   * Optional advisory prose scan. Matched tokens are surfaced in the pass
   * response but NEVER cause a 409 block.
   */
  advisory?: {
    allText: string;
    /** Tokens the agent acknowledges as false positives (audit-logged). */
    acknowledgedTokens?: string[];
    acknowledgedReason?: string;
  };
}

export function evaluateGuard(input: GuardInput): GuardDecision {
  const { state, advisory } = input;

  const blockedBy: StructuredBlockerReason[] = [];
  if (state.unresolvedBlockerCount > 0) blockedBy.push("open_blockedby_links");
  if (state.openChildCount > 0) blockedBy.push("open_child_issues");
  if (state.hasPendingConfirmation) blockedBy.push("pending_confirmation");
  if (state.hasActiveRecoveryAction) blockedBy.push("active_recovery_action");

  if (blockedBy.length > 0) {
    return { decision: "blocked", blockedBy };
  }

  // Structured state is clean. Run optional advisory prose scan.
  if (advisory) {
    const matched = findMatchedGuardTokens(advisory.allText, BUILTIN_GUARD_TOKENS);
    if (matched.length > 0) {
      const ackSet = new Set(
        (advisory.acknowledgedTokens ?? []).map((t) => t.toLowerCase()),
      );
      const acknowledged = matched.every((t) => ackSet.has(t.toLowerCase()));
      return {
        decision: "pass",
        advisory: {
          matchedTokens: matched,
          acknowledged,
          acknowledgedReason: acknowledged
            ? (advisory.acknowledgedReason ?? "")
            : undefined,
        },
      };
    }
  }

  return { decision: "pass" };
}
