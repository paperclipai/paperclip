/**
 * Minimal GitHub REST client for paperclip-github-sync.
 *
 * Security invariants (never violate):
 *   - The PAT token is NEVER logged, printed, or included in thrown errors.
 *   - All error messages pass through redactToken() before surfacing.
 *   - redirect: "error" prevents following unexpected redirects.
 *   - The constructed URL's host is validated against baseUrl on every call.
 */

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  /** Direct API hostname: "api.github.com" for github.com, or an enterprise API host. */
  apiHost: string;
  /** PAT — NEVER pass this into logs, comments, or state. */
  token: string;
  /** Injectable for unit tests; defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
}

export interface GitHubIssue {
  number: number;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
}

export interface RateLimitState {
  remaining: number;
  reset: number;       // unix timestamp (seconds)
  retryAfter?: number; // seconds, from Retry-After header
}

export class GitHubRateLimitError extends Error {
  constructor(public readonly rateLimit: RateLimitState) {
    super(
      `GitHub rate limit exhausted: ${rateLimit.remaining} remaining, resets at ${rateLimit.reset}`,
    );
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** Replace every occurrence of `token` in `text` with `[REDACTED]`. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

/**
 * Map a user-facing GitHub hostname to the REST API host.
 * "github.com" → "api.github.com"
 * Anything else (GHE) → returned unchanged (caller sets the /api/v3 prefix if needed).
 */
export function resolveApiHost(host: string): string {
  return host === "github.com" ? "api.github.com" : host;
}

function parseRateLimit(headers: Headers): RateLimitState {
  const remainingRaw = headers.get("x-ratelimit-remaining");
  const resetRaw = headers.get("x-ratelimit-reset");
  const retryAfterRaw = headers.get("retry-after");

  const remaining = remainingRaw !== null ? parseInt(remainingRaw, 10) : 1000;
  const reset = resetRaw !== null ? parseInt(resetRaw, 10) : 0;
  const retryAfterParsed = retryAfterRaw !== null ? parseInt(retryAfterRaw, 10) : undefined;

  return {
    remaining: isNaN(remaining) ? 1000 : remaining,
    reset: isNaN(reset) ? 0 : reset,
    retryAfter:
      retryAfterParsed !== undefined && !isNaN(retryAfterParsed)
        ? retryAfterParsed
        : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RATE_LIMIT_FLOOR = 100;
const MAX_RETRIES = 3;

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly expectedHost: string;
  private readonly _token: string;
  private readonly _fetchFn: typeof globalThis.fetch;
  private _rateLimit: RateLimitState = { remaining: 1000, reset: 0 };

  constructor(options: GitHubClientOptions) {
    const { owner, repo, apiHost, token, fetchFn } = options;
    this._token = token;
    this._fetchFn = fetchFn ?? globalThis.fetch;
    this.baseUrl = `https://${apiHost}/repos/${owner}/${repo}`;
    this.expectedHost = new URL(this.baseUrl).host;
  }

  /** Last observed rate-limit state (updated after each successful response). */
  get rateLimit(): Readonly<RateLimitState> {
    return this._rateLimit;
  }

  private redact(text: string): string {
    return redactToken(text, this._token);
  }

  /** Wait until the rate-limit window resets when remaining drops below floor. */
  private async backoffIfNeeded(): Promise<void> {
    if (this._rateLimit.remaining < RATE_LIMIT_FLOOR && this._rateLimit.reset > 0) {
      const nowSecs = Math.floor(Date.now() / 1000);
      const waitSecs = this._rateLimit.reset - nowSecs + 1;
      if (waitSecs > 0) {
        await sleep(waitSecs * 1000);
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<{ data: T; rateLimit: RateLimitState }> {
    await this.backoffIfNeeded();

    const url = `${this.baseUrl}${path}`;

    // Belt-and-suspenders host pin: constructed URL must stay on the configured host.
    if (new URL(url).host !== this.expectedHost) {
      throw new GitHubApiError(
        0,
        `URL host mismatch — expected ${this.expectedHost}`,
      );
    }

    let response: Response;
    try {
      response = await this._fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "paperclip-github-sync/0.1.0",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GitHubApiError(0, this.redact(`GitHub fetch failed: ${msg}`));
    }

    const rateLimit = parseRateLimit(response.headers);
    this._rateLimit = rateLimit;

    // Retry on rate-limit 429, or on 403 only when rate limit is actually exhausted.
    const isRateLimited =
      response.status === 429 ||
      (response.status === 403 && rateLimit.remaining === 0);

    if (isRateLimited) {
      if (attempt >= MAX_RETRIES) {
        throw new GitHubRateLimitError(rateLimit);
      }
      const waitMs =
        rateLimit.retryAfter != null
          ? rateLimit.retryAfter * 1000
          : Math.min(1000 * Math.pow(2, attempt + 1), 64_000);
      await sleep(waitMs);
      return this.request<T>(method, path, body, attempt + 1);
    }

    if (!response.ok) {
      let errBody = "";
      try {
        errBody = await response.text();
      } catch {
        // best-effort
      }
      throw new GitHubApiError(
        response.status,
        this.redact(`GitHub API error ${response.status}: ${errBody.slice(0, 200)}`),
      );
    }

    let data: T;
    try {
      data = (await response.json()) as T;
    } catch {
      throw new GitHubApiError(response.status, "GitHub API returned non-JSON response");
    }

    return { data, rateLimit };
  }

  async createIssue(params: {
    title: string;
    body?: string;
    labels?: string[];
  }): Promise<{ issue: GitHubIssue; rateLimit: RateLimitState }> {
    const { data, rateLimit } = await this.request<GitHubIssue>("POST", "/issues", {
      title: params.title,
      body: params.body ?? "",
      labels: params.labels ?? [],
    });
    return { issue: data, rateLimit };
  }

  async updateIssue(
    issueNumber: number,
    params: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      state_reason?: "completed" | "not_planned" | "reopened";
      labels?: string[];
    },
  ): Promise<{ issue: GitHubIssue; rateLimit: RateLimitState }> {
    const { data, rateLimit } = await this.request<GitHubIssue>(
      "PATCH",
      `/issues/${issueNumber}`,
      params,
    );
    return { issue: data, rateLimit };
  }

  async closeIssue(
    issueNumber: number,
    stateReason: "completed" | "not_planned" = "completed",
  ): Promise<{ issue: GitHubIssue; rateLimit: RateLimitState }> {
    return this.updateIssue(issueNumber, { state: "closed", state_reason: stateReason });
  }

  async reopenIssue(
    issueNumber: number,
  ): Promise<{ issue: GitHubIssue; rateLimit: RateLimitState }> {
    return this.updateIssue(issueNumber, { state: "open", state_reason: "reopened" });
  }

  async addLabel(
    issueNumber: number,
    labels: string[],
  ): Promise<{ labels: Array<{ name: string }>; rateLimit: RateLimitState }> {
    const { data, rateLimit } = await this.request<Array<{ name: string }>>(
      "POST",
      `/issues/${issueNumber}/labels`,
      { labels },
    );
    return { labels: data, rateLimit };
  }
}
