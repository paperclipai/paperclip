import { Redis } from "@upstash/redis";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "./company-search-rate-limit.js";
import { createUpstashCompanySearchRateLimiter } from "./company-search-rate-limit-upstash.js";

/**
 * Resolve the rate limiter backend from the environment.
 *
 * - When both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, use the
 *   distributed Upstash backend (correct across multiple serverless instances).
 * - Otherwise fall back to the in-memory limiter, which is fine for local development
 *   but only enforces the limit per-process.
 */
export function resolveCompanySearchRateLimiter(
  env: NodeJS.ProcessEnv = process.env,
): CompanySearchRateLimiter {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (url && token) {
    const redis = new Redis({ url, token });
    return createUpstashCompanySearchRateLimiter({ redis });
  }

  return createCompanySearchRateLimiter();
}
