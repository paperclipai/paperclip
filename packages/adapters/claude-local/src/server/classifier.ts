// Failover classifier for the claude_local adapter.
//
// Spec source: ROCAA-27 (Failover classifier spec, log schema, and test fixtures).
// Wiring: ROCAA-28. Tier 1 runner: ROCAA-29.
//
// The classifier is pure: it inspects fields off the Tier 0 process result and
// returns a verdict. It does not re-spawn, re-parse, or know which tier called
// it; loop-prevention is the wiring layer's job (Tier 1 outcomes never feed
// back into the classifier).
//
// Starting regex from the parent ticket — kept here so future readers can grep
// from the ticket to the code: /rate.?limit|429|ECONN|ETIMEDOUT|fetch failed|token.refresh/i
// That regex is insufficient on its own (misses revoked-token vs. transient,
// quota vs. rate-limit, Anthropic 5xx, CLI panics, malformed JSON). The
// decision order below subsumes it.

import {
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

/** Bump when decision order or reason taxonomy changes. */
export const CLASSIFIER_VERSION = "1.0.0";

export type Tier = "tier_0_claude_cli" | "tier_1_anthropic_sdk";

export type RecoverabilityReason =
  | "rate_limit"
  | "quota_exhausted"
  | "token_refresh_transient"
  | "token_refresh_revoked"
  | "network_econnreset"
  | "network_etimedout"
  | "network_fetch_failed"
  | "anthropic_5xx"
  | "claude_cli_panic"
  | "malformed_stream_json"
  | "auth_required"
  | "max_turns"
  | "timeout"
  | "unknown_session"
  | "user_abort"
  | "non_recoverable_other"
  | "ok";

export interface RecoverabilityVerdict {
  recoverable: boolean;
  /** Stable id used in tier_transitions[].reason and metrics. */
  reason: RecoverabilityReason;
  /** Which regex / parsed-field matched. Logged verbatim in tier_transitions[]. */
  match: string | null;
  /** Optional human-readable hint that the wiring layer can echo to onLog. */
  detail?: string;
}

export interface ClassifierInput {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  parsed: Record<string, unknown> | null;
  timedOut: boolean;
}

interface RegexRule {
  reason: RecoverabilityReason;
  recoverable: boolean;
  pattern: RegExp;
}

// Order matters. Evaluated against `${stderr}\n${stdout}` so signals split
// between channels both match. Each rule's `pattern` is matched against the
// raw text; the first capturing of the match string is stored verbatim.

// Token-refresh: revoked path FIRST, before any generic refresh signal.
const RULE_TOKEN_REVOKED: RegexRule = {
  reason: "token_refresh_revoked",
  recoverable: false,
  pattern: /(invalid_grant|refresh.token.*revoked|account.*disabled|unauthorized_client)/i,
};

// Quota exhausted BEFORE plain rate limit. Quota is a policy signal, not a
// load-shed signal — auto-retry on quota would burn operators.
const RULE_QUOTA_EXHAUSTED: RegexRule = {
  reason: "quota_exhausted",
  recoverable: false,
  pattern: /(quota.exhausted|monthly.limit|usage.limit.reached|insufficient_quota|credit.balance.too.low|"type"\s*:\s*"billing_error")/i,
};

const RULE_RATE_LIMIT: RegexRule = {
  reason: "rate_limit",
  recoverable: true,
  pattern: /rate.?limit|HTTP\s*429|"status"\s*:\s*429|Too Many Requests/i,
};

const RULE_TOKEN_REFRESH_TRANSIENT: RegexRule = {
  reason: "token_refresh_transient",
  recoverable: true,
  pattern: /token.refresh|access.token.expired|reauth(?:enticate)?|refresh.failed.*retry/i,
};

const RULE_ECONNRESET: RegexRule = {
  reason: "network_econnreset",
  recoverable: true,
  pattern: /ECONNRESET|socket hang up|read ECONNRESET|stream.*aborted/i,
};

const RULE_ETIMEDOUT: RegexRule = {
  reason: "network_etimedout",
  recoverable: true,
  pattern: /ETIMEDOUT|connect ETIMEDOUT|request timeout/i,
};

const RULE_FETCH_FAILED: RegexRule = {
  reason: "network_fetch_failed",
  recoverable: true,
  pattern: /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|getaddrinfo/i,
};

const RULE_ANTHROPIC_5XX: RegexRule = {
  reason: "anthropic_5xx",
  recoverable: true,
  pattern: /HTTP\s*5\d\d|"status"\s*:\s*5\d\d|overloaded_error|api_error.*server|service.unavailable|bad.gateway/i,
};

// Claude CLI panic — the binary itself crashed. Tier 1 bypasses the binary, so
// this is exactly the failure shape Tier 1 earns its keep on.
const RULE_CLAUDE_CLI_PANIC: RegexRule = {
  reason: "claude_cli_panic",
  recoverable: true,
  // We also gate on non-zero exit at the call site (see runRegexRules).
  pattern: /panic:|Uncaught (Exception|Error)|Segmentation fault|node:internal\/.*Error/,
};

const SIGINT_PATTERN = /SIGINT|Aborted by user/i;

/**
 * Inspect a Tier 0 outcome and decide whether failover should fire.
 * See ROCAA-27 "Decision order" — order is meaningful and tested by fixture.
 */
export function isRecoverable(input: ClassifierInput): RecoverabilityVerdict {
  const { exitCode, stderr, stdout, parsed, timedOut } = input;

  // 1. Hard timeout: Tier 1 is not magically faster than Tier 0; let timeout
  // policy handle it.
  if (timedOut) {
    return { recoverable: false, reason: "timeout", match: null };
  }

  // 2. Login required — silently swapping to a different billing path would
  // hide a human-in-the-loop event. Surface, do not failover.
  const loginMeta = detectClaudeLoginRequired({ parsed, stdout, stderr });
  if (loginMeta.requiresLogin) {
    return {
      recoverable: false,
      reason: "auth_required",
      match: loginMeta.loginUrl ? `loginUrl=${loginMeta.loginUrl}` : "claude_auth_required",
    };
  }

  // 3. Max turns — graceful termination, exit 0; retrying just blows turns.
  if (parsed && isClaudeMaxTurnsResult(parsed)) {
    return { recoverable: false, reason: "max_turns", match: "subtype=error_max_turns" };
  }

  // 4. Unknown session — existing resume-retry branch in execute.ts handles
  // this. The classifier explicitly tags it non-recoverable so Tier 1 cannot
  // double-fire on top of that branch.
  if (parsed && isClaudeUnknownSessionError(parsed)) {
    return { recoverable: false, reason: "unknown_session", match: "no conversation found with session id" };
  }

  // 5. User-initiated abort.
  if (exitCode === 130 || SIGINT_PATTERN.test(stderr) || SIGINT_PATTERN.test(stdout)) {
    return { recoverable: false, reason: "user_abort", match: exitCode === 130 ? "exitCode=130" : "SIGINT" };
  }

  // 6+. Regex rules in priority order. We match against `${stderr}\n${stdout}`
  // so a signal in either stream wins.
  const haystack = `${stderr}\n${stdout}`;

  const orderedRules: RegexRule[] = [
    RULE_TOKEN_REVOKED,
    RULE_QUOTA_EXHAUSTED,
    RULE_RATE_LIMIT,
    RULE_TOKEN_REFRESH_TRANSIENT,
    RULE_ECONNRESET,
    RULE_ETIMEDOUT,
    RULE_FETCH_FAILED,
    RULE_ANTHROPIC_5XX,
  ];
  for (const rule of orderedRules) {
    const m = haystack.match(rule.pattern);
    if (m) {
      return { recoverable: rule.recoverable, reason: rule.reason, match: truncateMatch(m[0]) };
    }
  }

  // 12. Claude CLI panic — gated on non-zero exit. A zero-exit panic regex
  // hit on stdout would be a false positive (panics-as-text in successful
  // tool output, etc.).
  if ((exitCode ?? 0) !== 0) {
    const panicHit = haystack.match(RULE_CLAUDE_CLI_PANIC.pattern);
    if (panicHit) {
      return {
        recoverable: true,
        reason: "claude_cli_panic",
        match: truncateMatch(panicHit[0]),
      };
    }
  }

  // 13. Malformed stream JSON: exit 0 but parsed is null. Stream cut before
  // final result event. Tier 1 retries the prompt and gets a clean result.
  if (parsed == null && (exitCode ?? 0) === 0) {
    return { recoverable: true, reason: "malformed_stream_json", match: "exit_0_no_parsed_result" };
  }

  // 14. Non-zero exit with no specific signal: do not retry.
  if ((exitCode ?? 0) !== 0) {
    return { recoverable: false, reason: "non_recoverable_other", match: `exitCode=${exitCode ?? -1}` };
  }

  // 15. Exit 0 with parsed result. Caller typically short-circuits before
  // calling the classifier on success; this exists for safety.
  return { recoverable: false, reason: "ok", match: null };
}

function truncateMatch(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > 240 ? value.slice(0, 240) : value;
}
