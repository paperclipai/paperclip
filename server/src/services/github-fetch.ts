import { unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

/** Default wall-clock bound for GitHub / raw.githubusercontent.com outbound calls. */
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 45_000;

const MAX_IDEMPOTENT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const MAX_RETRY_AFTER_MS = 120_000;

export type GhFetchInit = RequestInit & {
  /** Override default outbound deadline (ms). Not forwarded to `fetch`. */
  timeoutMs?: number;
};

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener(
      "abort",
      () => {
        controller.abort(s.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

function resolveHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "remote host";
  }
}

function requestMethod(init?: GhFetchInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredBackoffMs(attemptIndex: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attemptIndex;
  return base + Math.floor(Math.random() * base * 0.25);
}

function shouldRetryHttpStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

function retryAfterMsFromResponse(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const asNum = Number(raw.trim());
  if (!Number.isFinite(asNum) || asNum < 0) return null;
  return Math.min(asNum * 1000, MAX_RETRY_AFTER_MS);
}

function stripGhFetchInit(init?: GhFetchInit): RequestInit {
  if (!init) return {};
  const { timeoutMs: _timeout, ...rest } = init;
  return rest;
}

/**
 * Outbound fetch for GitHub / GHE with a default deadline and bounded retries
 * for idempotent methods (GET/HEAD): transient 5xx, 429, and network errors
 * retry up to {@link MAX_IDEMPOTENT_ATTEMPTS} attempts with exponential backoff
 * and jitter. Non-idempotent requests use a single attempt.
 */
export async function ghFetch(url: string, init?: GhFetchInit): Promise<Response> {
  const hostname = resolveHostname(url);
  const method = requestMethod(init);
  const idempotent = isIdempotentMethod(method);
  const maxAttempts = idempotent ? MAX_IDEMPOTENT_ATTEMPTS : 1;
  const timeoutMs = init?.timeoutMs ?? GH_FETCH_DEFAULT_TIMEOUT_MS;
  const fetchInitBase = stripGhFetchInit(init);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const userSignal = fetchInitBase.signal;
    const combinedSignal = userSignal ? mergeAbortSignals([deadline, userSignal]) : deadline;

    try {
      const response = await fetch(url, {
        ...fetchInitBase,
        signal: combinedSignal,
      });

      if (
        idempotent
        && shouldRetryHttpStatus(response.status)
        && attempt < maxAttempts - 1
      ) {
        await response.body?.cancel().catch(() => {});
        const afterMs = response.status === 429 ? retryAfterMsFromResponse(response) : null;
        await sleep(afterMs ?? jitteredBackoffMs(attempt));
        continue;
      }

      return response;
    } catch (err) {
      const isDeadline =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (isDeadline && fetchInitBase.signal?.aborted) {
        throw err;
      }
      if (isDeadline) {
        throw unprocessable(
          `Request to ${hostname} timed out after ${timeoutMs}ms — ensure the URL points to a GitHub or GitHub Enterprise instance`,
        );
      }
      if (!idempotent || attempt === maxAttempts - 1) {
        throw unprocessable(
          `Could not connect to ${hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`,
        );
      }
      await sleep(jitteredBackoffMs(attempt));
    }
  }

  throw new Error("ghFetch: internal error — retry loop exited without result");
}
