// Statuses that say "ask again", not "the answer is no". A release must not be
// blocked because GitHub returned a gateway error during a 60-minute poll.
const TRANSIENT_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// A rate-limited read also says "ask again", and GitHub reports both primary
// and secondary rate limits as 403. Only the headers separate that from a
// token that may not read Actions, which must still fail at once.
function rateLimited(response) {
  if (response.status !== 403) return false;
  const header = (name) => response.headers?.get?.(name) ?? null;
  return header("retry-after") !== null || header("x-ratelimit-remaining") === "0";
}

/** Milliseconds from a Retry-After header, when it carries a sane delay. */
function retryAfterMs(response, capMs) {
  const value = Number(response?.headers?.get?.("retry-after"));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value * 1_000, capMs);
}

/**
 * The GitHub Actions read used by the polling below, with transient transport
 * failures retried: network errors, the statuses above, rate-limited 403s, and
 * a body that fails while it is being read. Any other non-OK status throws on
 * the first response, because waiting out a wrong token only delays the news.
 *
 * `deadlineAt` bounds retries by the caller's own polling deadline, so a read
 * cannot extend the wait past the timeout it belongs to.
 */
export function createActionsReader({
  token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 4, backoffMs = 1_000, log = console.log,
  now = Date.now, deadlineAt = () => Infinity, maxRetryAfterMs = 60_000,
} = {}) {
  return async (path) => {
    for (let attempt = 1; ; attempt += 1) {
      // Retry only while both the attempt budget and the caller's deadline
      // leave room for the wait this attempt would cost.
      const waitMs = backoffMs * attempt;
      const retryable = attempt < attempts && now() + waitMs < deadlineAt();
      const pause = (response) => sleep(retryAfterMs(response, maxRetryAfterMs) ?? waitMs);
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(30_000), redirect: "error",
        });
      } catch (cause) {
        if (!retryable) throw new Error(`GitHub Actions read failed: ${cause.message}`);
        log(`GitHub Actions read failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
        await pause();
        continue;
      }
      if (response.ok) {
        try {
          // A 200 whose body is truncated or undecodable is a transport
          // failure like any other, so it belongs inside the retry.
          return await response.json();
        } catch (cause) {
          if (!retryable) throw new Error(`GitHub Actions read failed: ${cause.message}`);
          log(`GitHub Actions read body failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
          await pause();
          continue;
        }
      }
      if (!retryable || !(TRANSIENT_READ_STATUSES.has(response.status) || rateLimited(response))) {
        throw new Error(`GitHub Actions read failed (HTTP ${response.status}).`);
      }
      log(`GitHub Actions read failed (HTTP ${response.status}); retrying (${attempt}/${attempts - 1}).`);
      await pause(response);
    }
  };
}
