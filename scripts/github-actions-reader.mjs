const TRANSIENT_READ_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const rateResources = new Set(["core", "search", "code_search", "graphql", "integration_manifest", "actions_runner_registration"]);

function rateLimited(response) {
  return response.status === 429 || (response.status === 403 &&
    (response.headers?.get?.("retry-after") != null || response.headers?.get?.("x-ratelimit-remaining") === "0"));
}

function numericHeader(response, name) {
  const value = response.headers?.get?.(name);
  if (!/^\d+$/.test(value ?? "")) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function quota(response, tokenSource) {
  const seconds = numericHeader(response, "x-ratelimit-reset");
  const reset = seconds !== undefined && seconds <= 8_640_000_000_000 ? seconds * 1000 : undefined;
  const resource = response.headers?.get?.("x-ratelimit-resource");
  return { status: response.status, credential: tokenSource === "github.token" ? "github.token" : "configured credential",
    ...(rateResources.has(resource) ? { resource } : {}),
    limit: numericHeader(response, "x-ratelimit-limit"), remaining: numericHeader(response, "x-ratelimit-remaining"), reset };
}

export class GitHubActionsRateLimitError extends Error {
  constructor(details) {
    const fields = [`HTTP ${details.status}`, `credential: ${details.credential}`];
    for (const name of ["resource", "limit", "remaining"]) if (details[name] !== undefined) fields.push(`${name}: ${details[name]}`);
    if (details.reset !== undefined) fields.push(`reset: ${new Date(details.reset).toISOString()}`);
    super(`GitHub API rate limited (${fields.join("; ")}).`);
    this.name = "GitHubActionsRateLimitError";
  }
}

function retryAfterMs(response, now) {
  const raw = response.headers?.get?.("retry-after");
  const parsed = raw == null || raw.trim() === "" ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
  return Number.isFinite(parsed) && parsed > now ? parsed - now : undefined;
}

function quotaWait(response, details, now, attempt) {
  const retryAfter = retryAfterMs(response, now);
  const resetWait = details.remaining === 0 && details.reset !== undefined && details.reset > now ? details.reset - now + 1000 : undefined;
  return Math.max(retryAfter ?? 0, resetWait ?? 0) || 60_000 * 2 ** (attempt - 1);
}

export function createActionsReader({
  token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 4, backoffMs = 1_000, log = console.log,
  now = Date.now, deadlineAt = () => Infinity, maxRetryAfterMs = 15 * 60_000, tokenSource,
} = {}) {
  const cached = new Map();
  return async (path) => {
    const deadline = Math.min(deadlineAt(), now() + maxRetryAfterMs);
    for (let attempt = 1; ; attempt += 1) {
      const waitMs = backoffMs * attempt;
      const retryable = delay => attempt < attempts && now() + delay < Math.min(deadline, deadlineAt());
      let response;
      try {
        const etag = cached.get(path)?.etag;
        response = await fetchImpl(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            ...(etag ? { "If-None-Match": etag } : {}),
          },
          signal: AbortSignal.timeout(30_000), redirect: "error",
        });
      } catch (cause) {
        if (!retryable(waitMs)) throw new Error(`GitHub Actions read failed: ${cause.message}`);
        log(`GitHub Actions read failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
        await sleep(waitMs);
        continue;
      }
      if (response.status === 304 && cached.has(path)) return structuredClone(cached.get(path).body);
      if (response.ok) {
        try {
          const body = await response.json();
          const etag = response.headers?.get?.("etag");
          if (etag) cached.set(path, { etag, body: structuredClone(body) });
          else cached.delete(path);
          return body;
        } catch (cause) {
          if (!retryable(waitMs)) throw new Error(`GitHub Actions read failed: ${cause.message}`);
          log(`GitHub Actions read body failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
          await sleep(waitMs);
          continue;
        }
      }
      void response.body?.cancel().catch(() => {});
      if (rateLimited(response)) {
        const details = quota(response, tokenSource);
        const error = new GitHubActionsRateLimitError(details);
        const delay = quotaWait(response, details, now(), attempt);
        if (!retryable(delay)) throw error;
        log(`${error.message} Waiting ${Math.ceil(delay / 1000)}s before retry ${attempt}/${attempts - 1}.`);
        await sleep(delay);
        continue;
      }
      const delay = Math.max(waitMs, retryAfterMs(response, now()) ?? 0);
      if (!TRANSIENT_READ_STATUSES.has(response.status) || !retryable(delay)) {
        throw new Error(`GitHub Actions read failed (HTTP ${response.status}).`);
      }
      log(`GitHub Actions read failed (HTTP ${response.status}); retrying (${attempt}/${attempts - 1}).`);
      await sleep(delay);
    }
  };
}
