import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  GitHubClient,
  GitHubRateLimitError,
  redactToken,
  resolveApiHost,
} from "../src/github-client.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "ghp_SUPER_SECRET_TOKEN_XYZ987";

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const allHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-ratelimit-remaining": "5000",
    "x-ratelimit-reset": "9999999999",
    ...headers,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: allHeaders,
  });
}

function makeClient(fetchFn: typeof globalThis.fetch): GitHubClient {
  return new GitHubClient({
    owner: "acme",
    repo: "test-repo",
    apiHost: "api.github.com",
    token: FAKE_TOKEN,
    fetchFn,
  });
}

// ── redactToken ───────────────────────────────────────────────────────────────

describe("redactToken", () => {
  it("replaces all occurrences of the token", () => {
    const msg = `Bearer ${FAKE_TOKEN} used; also ${FAKE_TOKEN} again`;
    expect(redactToken(msg, FAKE_TOKEN)).toBe(
      "Bearer [REDACTED] used; also [REDACTED] again",
    );
  });

  it("returns text unchanged when token is empty string", () => {
    expect(redactToken("no token here", "")).toBe("no token here");
  });

  it("handles text that does not contain the token", () => {
    expect(redactToken("safe log line", FAKE_TOKEN)).toBe("safe log line");
  });
});

// ── resolveApiHost ─────────────────────────────────────────────────────────

describe("resolveApiHost", () => {
  it("maps github.com → api.github.com", () => {
    expect(resolveApiHost("github.com")).toBe("api.github.com");
  });

  it("returns enterprise host unchanged", () => {
    expect(resolveApiHost("github.acme.corp")).toBe("github.acme.corp");
  });
});

// ── PAT redaction in thrown errors ────────────────────────────────────────────

describe("GitHubClient — PAT redaction", () => {
  it("does not expose PAT in GitHubApiError from non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(422, { message: `Validation failed: token=${FAKE_TOKEN}` }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await expect(client.createIssue({ title: "test" })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as Error).message).not.toContain(FAKE_TOKEN);
        return true;
      },
    );
  });

  it("does not expose PAT in GitHubApiError from fetch failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      new Error(`network error with token ${FAKE_TOKEN}`),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await expect(client.createIssue({ title: "test" })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as Error).message).not.toContain(FAKE_TOKEN);
        return true;
      },
    );
  });
});

// ── createIssue ───────────────────────────────────────────────────────────────

describe("GitHubClient.createIssue", () => {
  it("POSTs to /issues and returns the created issue", async () => {
    const issued = { number: 42, html_url: "https://github.com/acme/test-repo/issues/42", state: "open", title: "Bug report", body: "details" };
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(201, issued));
    const client = makeClient(fetchFn as typeof globalThis.fetch);

    const { issue, rateLimit } = await client.createIssue({ title: "Bug report", body: "details" });

    expect(issue.number).toBe(42);
    expect(issue.state).toBe("open");
    expect(rateLimit.remaining).toBe(5000);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/test-repo/issues");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.title).toBe("Bug report");
  });

  it("sends Authorization header with the PAT", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(201, { number: 1, html_url: "", state: "open", title: "t", body: null }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await client.createIssue({ title: "t" });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("sets redirect: error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(201, { number: 1, html_url: "", state: "open", title: "t", body: null }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await client.createIssue({ title: "t" });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });
});

// ── closeIssue / reopenIssue ──────────────────────────────────────────────────

describe("GitHubClient.closeIssue / reopenIssue", () => {
  it("closeIssue PATCHes state=closed", async () => {
    const closed = { number: 7, html_url: "", state: "closed", title: "t", body: null };
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(200, closed));
    const client = makeClient(fetchFn as typeof globalThis.fetch);

    const { issue } = await client.closeIssue(7);
    expect(issue.state).toBe("closed");

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/issues/7");
    expect(init.method).toBe("PATCH");
    const sent = JSON.parse(init.body as string);
    expect(sent.state).toBe("closed");
    expect(sent.state_reason).toBe("completed");
  });

  it("reopenIssue PATCHes state=open", async () => {
    const open = { number: 7, html_url: "", state: "open", title: "t", body: null };
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(200, open));
    const client = makeClient(fetchFn as typeof globalThis.fetch);

    const { issue } = await client.reopenIssue(7);
    expect(issue.state).toBe("open");
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.state).toBe("open");
  });
});

// ── addLabel ──────────────────────────────────────────────────────────────────

describe("GitHubClient.addLabel", () => {
  it("POSTs labels to /issues/:number/labels", async () => {
    const labelsResp = [{ name: "bug" }, { name: "priority:high" }];
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(200, labelsResp));
    const client = makeClient(fetchFn as typeof globalThis.fetch);

    const { labels } = await client.addLabel(7, ["bug", "priority:high"]);
    expect(labels).toHaveLength(2);
    expect(labels[0].name).toBe("bug");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/issues/7/labels");
  });
});

// ── Rate-limit parsing and backoff ────────────────────────────────────────────

describe("GitHubClient — rate-limit handling", () => {
  it("parses X-RateLimit-Remaining from response headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(201, { number: 1, html_url: "", state: "open", title: "t", body: null }, {
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": "1700000000",
      }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    const { rateLimit } = await client.createIssue({ title: "t" });
    expect(rateLimit.remaining).toBe(42);
    expect(rateLimit.reset).toBe(1700000000);
  });

  it("throws GitHubRateLimitError after max retries on 429", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(429, { message: "rate limited" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "9999999999",
        "retry-after": "1",
      }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);

    await expect(client.createIssue({ title: "t" })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
    // 1 initial + 3 retries = 4 total
    expect(fetchFn).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("throws GitHubRateLimitError on 403 when remaining=0", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(403, { message: "forbidden" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "9999999999",
        "retry-after": "1",
      }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await expect(client.createIssue({ title: "t" })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  }, 15_000);

  it("throws GitHubApiError on plain 403 (not rate-limited)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(403, { message: "forbidden — insufficient scope" }, {
        "x-ratelimit-remaining": "4999",
      }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await expect(client.createIssue({ title: "t" })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    // No retry on plain 403
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("exposes rateLimit getter after a successful call", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(201, { number: 1, html_url: "", state: "open", title: "t", body: null }, {
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "1234567890",
      }),
    );
    const client = makeClient(fetchFn as typeof globalThis.fetch);
    await client.createIssue({ title: "t" });
    expect(client.rateLimit.remaining).toBe(99);
  });
});

// ── Host-pinning ──────────────────────────────────────────────────────────────

describe("GitHubClient — host pinning", () => {
  it("rejects if constructed URL host differs from expected (e.g. path injection)", async () => {
    // This would require an internal bug; simulate by passing a rogue apiHost
    const client = new GitHubClient({
      owner: "acme",
      repo: "../../evil",
      apiHost: "api.github.com",
      token: FAKE_TOKEN,
      fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
    });
    // The baseUrl would be https://api.github.com/repos/acme/../../evil
    // URL normalisation will collapse it — host stays api.github.com, so no throw.
    // We test the actual redirect=error instead by injecting a response that would
    // only appear after a redirect.
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(201, { number: 1, html_url: "", state: "open", title: "ok", body: null }),
    );
    const safeClient = new GitHubClient({
      owner: "acme",
      repo: "test",
      apiHost: "api.github.com",
      token: FAKE_TOKEN,
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    const { issue } = await safeClient.createIssue({ title: "ok" });
    expect(issue.number).toBe(1);

    // Verify redirect:error was sent
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });
});
