export const COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS = 60_000;
export const COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS = 60;

export type CompanySearchRateLimitActor = {
  companyId: string;
  actorType: "agent" | "board";
  actorId: string;
};

export type CompanySearchRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type CompanySearchRateLimiter = {
  consume(actor: CompanySearchRateLimitActor): Promise<CompanySearchRateLimitResult>;
};

export function companySearchRateLimitKey(actor: CompanySearchRateLimitActor): string {
  return `${actor.companyId}:${actor.actorType}:${actor.actorId}`;
}

/**
 * In-memory sliding-window limiter. Suitable for local development and single-process
 * deployments only — each process keeps its own counters, so it does NOT enforce a
 * global limit across multiple serverless instances. Use the Upstash backend in
 * production (see {@link ./company-search-rate-limit-upstash.ts}).
 */
export function createCompanySearchRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
} = {}): CompanySearchRateLimiter {
  const windowMs = options.windowMs ?? COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  return {
    async consume(actor) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const actorKey = companySearchRateLimitKey(actor);
      const recentHits = (hitsByKey.get(actorKey) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxRequests) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByKey.set(actorKey, recentHits);
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(actorKey, recentHits);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}
