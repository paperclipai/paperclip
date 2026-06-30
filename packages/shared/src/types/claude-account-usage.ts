/**
 * Multi-account Claude subscription usage capture (TWX-1117 / TWX-1118).
 *
 * Host-level snapshot of every `~/.claude/auth-profiles/*` account's subscription
 * usage, captured WITHOUT switching the host's active auth. The probe reads each
 * profile's own OAuth token and queries Anthropic's usage endpoint; inactive
 * profiles whose snapshot token has been revoked are refreshed (rotating) and
 * persisted back atomically. See knowledge/tue-Jonas/claude-oauth-usage-and-refresh-endpoints.md.
 */

export const CLAUDE_ACCOUNT_TIERS = ["ours", "wameling", "unknown"] as const;
export type ClaudeAccountTier = (typeof CLAUDE_ACCOUNT_TIERS)[number];

/**
 * Default tier map by profile name (the `*.credentials.json` filename stem under
 * `~/.claude/auth-profiles/`). "ours" accounts may be burned freely; "wameling"
 * customer accounts should only be burned near their reset. Overridable per host
 * via the `CLAUDE_ACCOUNT_TIERS` env var (JSON: `{ "<profile>": "ours" | "wameling" }`).
 */
export const DEFAULT_CLAUDE_ACCOUNT_TIERS: Record<string, ClaudeAccountTier> = {
  "j-tuechler-twb-digital": "ours",
  thomas: "ours",
  "ild-claude-web.de": "wameling",
  "ild-claude-2-web.de": "wameling",
  "steven-i-love-design.de": "wameling",
};

/**
 * Infer an account's tier from its profile name. Falls back to a heuristic
 * (i-love-design / ild- / steven => wameling) before defaulting to "unknown",
 * so a newly added customer profile is classified sensibly even before the map
 * is updated.
 */
export function inferClaudeAccountTier(
  profile: string,
  overrides?: Record<string, ClaudeAccountTier>,
): ClaudeAccountTier {
  const fromOverride = overrides?.[profile];
  if (fromOverride) return fromOverride;
  const fromDefault = DEFAULT_CLAUDE_ACCOUNT_TIERS[profile];
  if (fromDefault) return fromDefault;
  const lower = profile.toLowerCase();
  if (lower.includes("i-love-design") || lower.startsWith("ild-") || lower.includes("steven")) {
    return "wameling";
  }
  return "unknown";
}

/** One usage window (5h or 7d) as a 0-100 percent + ISO reset timestamp. */
export interface ClaudeUsageWindow {
  pct: number | null;
  resetsAt: string | null;
}

/** Per-account usage snapshot returned by the read API and persisted per host. */
export interface ClaudeAccountUsageSnapshot {
  profile: string;
  email: string | null;
  subscriptionType: string | null;
  tier: ClaudeAccountTier;
  active: boolean;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  sevenDayOpus: ClaudeUsageWindow | null;
  sevenDaySonnet: ClaudeUsageWindow | null;
  /** ISO timestamp of the last successful or attempted probe. */
  probedAt: string;
  /**
   * How the usable token was obtained for this probe:
   * - "live": the active account, read from the live `~/.claude/.credentials.json`
   * - "snapshot": the profile's stored access token was still valid
   * - "refreshed": the stored token 401'd; refreshed (rotated) + persisted
   * - "error": no usable token / probe failed
   */
  source: "live" | "snapshot" | "refreshed" | "error";
  /** Non-null when this account could not be probed (e.g. 401, 429, network). */
  error: string | null;
}

export interface ClaudeAccountsUsageResponse {
  /** ISO timestamp of when this response's snapshots were last refreshed on the host. */
  capturedAt: string | null;
  accounts: ClaudeAccountUsageSnapshot[];
}
