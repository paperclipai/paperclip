import { describe, it, expect, vi, afterEach } from "vitest";

import { createCcrotateServeVerifier } from "./ccrotate-serve-verifier.js";

const baseOpts = {
  baseUrl: "http://serve.local:4001",
  token: "TOK",
  timeoutMs: 3_000,
  retries: 1,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 30_000,
  memoTtlMs: 30_000,
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
}

describe("createCcrotateServeVerifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns undefined when token is missing", () => {
    const v = createCcrotateServeVerifier({
      ...baseOpts,
      token: undefined as unknown as string,
    });
    expect(v).toBeUndefined();
  });

  it("returns undefined when token is empty string", () => {
    const v = createCcrotateServeVerifier({ ...baseOpts, token: "" });
    expect(v).toBeUndefined();
  });

  it("POSTs to /v1/internal/probe-one with bearer + JSON body and returns parsed result", async () => {
    const f = mockFetch(async () =>
      new Response(
        JSON.stringify({
          email: "bot4@blockcast.net",
          status: "success",
          serviceTier: "base",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const v = createCcrotateServeVerifier(baseOpts)!;
    const result = await v.probeOne("claude", "bot4@blockcast.net");
    expect(result.serviceTier).toBe("base");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://serve.local:4001/v1/internal/probe-one");
    const headers = init.headers as Record<string, string>;
    const authHeader = headers.authorization ?? headers.Authorization;
    expect(authHeader).toBe("Bearer TOK");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      target: "claude",
      email: "bot4@blockcast.net",
    });
  });

  it("throws VerifierError kind=auth on 401", async () => {
    mockFetch(async () => new Response("", { status: 401 }));
    const v = createCcrotateServeVerifier(baseOpts)!;
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("throws VerifierError kind=auth on 403", async () => {
    mockFetch(async () => new Response("", { status: 403 }));
    const v = createCcrotateServeVerifier(baseOpts)!;
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("does NOT retry auth errors (single call)", async () => {
    const f = mockFetch(async () => new Response("", { status: 401 }));
    const v = createCcrotateServeVerifier({ ...baseOpts, retries: 3 })!;
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "auth",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws VerifierError kind=transport on 5xx after 1 retry", async () => {
    const f = mockFetch(async () => new Response("", { status: 502 }));
    const v = createCcrotateServeVerifier(baseOpts)!;
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "transport",
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("returns success on retry after one transport error", async () => {
    let n = 0;
    mockFetch(async () => {
      n++;
      if (n === 1) throw new Error("socket hang up");
      return new Response(
        JSON.stringify({ email: "bot4", serviceTier: "base" }),
        { status: 200 },
      );
    });
    const v = createCcrotateServeVerifier(baseOpts)!;
    const result = await v.probeOne("claude", "bot4@blockcast.net");
    expect(result.serviceTier).toBe("base");
  });

  it("aborts on timeout and throws kind=transport", async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }) as unknown as Promise<Response>,
    );
    const v = createCcrotateServeVerifier({ ...baseOpts, timeoutMs: 50, retries: 0 })!;
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "transport",
    });
  });

  it("opens circuit after 3 consecutive transport errors; subsequent calls short-circuit without HTTP", async () => {
    const f = mockFetch(async () => new Response("", { status: 502 }));
    const v = createCcrotateServeVerifier({ ...baseOpts, retries: 0 })!;
    for (let i = 0; i < 3; i++) {
      await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
        kind: "transport",
      });
    }
    f.mockClear();
    await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toMatchObject({
      kind: "circuit_open",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("circuit re-closes after cooldown when probe succeeds", async () => {
    let attempts = 0;
    mockFetch(async () => {
      attempts++;
      if (attempts <= 3) return new Response("", { status: 502 });
      return new Response(
        JSON.stringify({ email: "bot4", serviceTier: "base" }),
        { status: 200 },
      );
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const v = createCcrotateServeVerifier({
      ...baseOpts,
      retries: 0,
      circuitBreakerCooldownMs: 1_000,
    })!;
    for (let i = 0; i < 3; i++) {
      await expect(v.probeOne("claude", "bot4@blockcast.net")).rejects.toThrow();
    }
    await vi.advanceTimersByTimeAsync(1_100);
    const ok = await v.probeOne("claude", "bot4@blockcast.net");
    expect(ok.serviceTier).toBe("base");
  });

  it("memos result by (target,email) within memoTtlMs", async () => {
    const f = mockFetch(async () =>
      new Response(
        JSON.stringify({ email: "bot4", serviceTier: "base" }),
        { status: 200 },
      ),
    );
    const v = createCcrotateServeVerifier(baseOpts)!;
    const a = await v.probeOne("claude", "bot4@blockcast.net");
    const b = await v.probeOne("claude", "bot4@blockcast.net");
    expect(a).toEqual(b);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("different (target,email) pairs do NOT share memo", async () => {
    const f = mockFetch(async () =>
      new Response(
        JSON.stringify({ email: "x", serviceTier: "base" }),
        { status: 200 },
      ),
    );
    const v = createCcrotateServeVerifier(baseOpts)!;
    await v.probeOne("claude", "a@x.com");
    await v.probeOne("claude", "b@x.com");
    await v.probeOne("codex", "a@x.com");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("dedupes in-flight calls to the same (target,email)", async () => {
    let resolveFn: (value: Response) => void = () => {};
    const f = mockFetch(
      () =>
        new Promise<Response>((res) => {
          resolveFn = res;
        }),
    );
    const v = createCcrotateServeVerifier(baseOpts)!;
    const p1 = v.probeOne("claude", "bot4@blockcast.net");
    const p2 = v.probeOne("claude", "bot4@blockcast.net");
    expect(f).toHaveBeenCalledTimes(1);
    resolveFn(
      new Response(
        JSON.stringify({ email: "bot4", serviceTier: "base" }),
        { status: 200 },
      ),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });
});
