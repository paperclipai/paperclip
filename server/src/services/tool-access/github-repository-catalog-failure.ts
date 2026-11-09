import { providerRetryAt } from "../provider-retry-after.js";
import { RepositoryCatalogUnavailableError } from "../repository-catalog-unavailable-error.js";

const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export function readGitHubRepositoryCatalogFailure(response: Pick<Response, "status" | "headers">, now = Date.now()) {
  const exhausted = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
  const retryAfter = providerRetryAt(response.headers.get("retry-after"), now);
  if (!exhausted && !(response.status === 403 && retryAfter !== undefined) && !transientStatuses.has(response.status)) return null;
  const rawReset = response.headers.get("x-ratelimit-reset");
  const reset = rawReset && /^\d{1,13}$/.test(rawReset) ? Number(rawReset) * 1000 : undefined;
  const quotaReset = (exhausted || response.status === 429) && reset && reset > now
    ? Math.min(reset, now + 24 * 3600_000) : undefined;
  const retryAt = retryAfter === undefined ? quotaReset : Math.max(retryAfter, quotaReset ?? retryAfter);
  return new RepositoryCatalogUnavailableError(retryAt);
}
