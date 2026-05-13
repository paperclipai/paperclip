/**
 * Sliding-window rate limiter for agent-driven issue creation.
 *
 * Design summary (ADR-008 §2.1, §2.2): we cap how many issues a single agent
 * can create within a rolling window inside one company. Limiter is in-memory
 * because the API server is single-process today; the {@link IssueCreateRateLimiter}
 * interface is intentionally small so we can swap to Redis later without
 * touching call sites.
 */

export const DEFAULT_ISSUE_CREATE_RATE_LIMIT_WINDOW_MINUTES = 10;
export const DEFAULT_ISSUE_CREATE_RATE_LIMIT_MAX_ISSUES_PER_WINDOW = 30;

export type IssueCreateRateLimitConfig = {
  enabled: boolean;
  windowMinutes: number;
  maxIssuesPerWindow: number;
  exemptAgentIds: readonly string[];
  exemptAgentRoles: readonly string[];
  governanceAssigneeAgentId: string | null;
  notifyUserIds: readonly string[];
};

export const DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG: IssueCreateRateLimitConfig = {
  enabled: true,
  windowMinutes: DEFAULT_ISSUE_CREATE_RATE_LIMIT_WINDOW_MINUTES,
  maxIssuesPerWindow: DEFAULT_ISSUE_CREATE_RATE_LIMIT_MAX_ISSUES_PER_WINDOW,
  exemptAgentIds: [],
  exemptAgentRoles: [],
  governanceAssigneeAgentId: null,
  notifyUserIds: [],
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * Parses the `rateLimits.issueCreation` shape stored on `companies.rate_limit_settings`.
 * Unknown / malformed values fall back to {@link DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG}
 * so a corrupted setting can never silently disable the guard.
 */
export function parseIssueCreateRateLimitConfig(input: unknown): IssueCreateRateLimitConfig {
  if (!input || typeof input !== "object") {
    return DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG;
  }
  const rateLimits = (input as Record<string, unknown>).rateLimits;
  const node = rateLimits && typeof rateLimits === "object"
    ? (rateLimits as Record<string, unknown>).issueCreation
    : (input as Record<string, unknown>).issueCreation;
  if (!node || typeof node !== "object") {
    return DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG;
  }
  const record = node as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean"
    ? record.enabled
    : DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG.enabled;
  const windowMinutes = isPositiveNumber(record.windowMinutes)
    ? record.windowMinutes
    : DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG.windowMinutes;
  const maxIssuesPerWindow = isPositiveNumber(record.maxIssuesPerWindow)
    ? record.maxIssuesPerWindow
    : DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG.maxIssuesPerWindow;
  const governanceAssigneeAgentId = typeof record.governanceAssigneeAgentId === "string"
    && record.governanceAssigneeAgentId.trim().length > 0
    ? record.governanceAssigneeAgentId
    : null;
  return {
    enabled,
    windowMinutes,
    maxIssuesPerWindow,
    exemptAgentIds: toStringArray(record.exemptAgentIds),
    exemptAgentRoles: toStringArray(record.exemptAgentRoles),
    governanceAssigneeAgentId,
    notifyUserIds: toStringArray(record.notifyUserIds),
  };
}

export type IssueCreateRateLimitActor = {
  companyId: string;
  agentId: string;
};

export type IssueCreateRateLimitResult = {
  allowed: boolean;
  limit: number;
  windowMinutes: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type IssueCreateRateLimiter = {
  consume(actor: IssueCreateRateLimitActor, config: IssueCreateRateLimitConfig): IssueCreateRateLimitResult;
  reset(actor?: IssueCreateRateLimitActor): void;
};

export function createIssueCreateRateLimiter(options: {
  now?: () => number;
} = {}): IssueCreateRateLimiter {
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  function key(actor: IssueCreateRateLimitActor) {
    return `${actor.companyId}:${actor.agentId}`;
  }

  return {
    consume(actor, config) {
      const limit = Math.max(1, Math.floor(config.maxIssuesPerWindow));
      const windowMinutes = Math.max(0.1, config.windowMinutes);
      const windowMs = windowMinutes * 60_000;
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const actorKey = key(actor);
      const recentHits = (hitsByKey.get(actorKey) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= limit) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByKey.set(actorKey, recentHits);
        return {
          allowed: false,
          limit,
          windowMinutes,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(actorKey, recentHits);
      return {
        allowed: true,
        limit,
        windowMinutes,
        remaining: Math.max(0, limit - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
    reset(actor) {
      if (!actor) {
        hitsByKey.clear();
        return;
      }
      hitsByKey.delete(key(actor));
    },
  };
}
