import { describe, expect, it, vi } from "vitest";
import {
  probeRuntimeApiUrl,
  resolveVerifiedRuntimeApiUrl,
  runtimeApiProbeUrl,
  type RuntimeApiProbeResult,
} from "../runtime-api-probe.js";

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json; charset=utf-8" },
  });
}

function htmlResponse(status = 200) {
  return new Response("<!doctype html><title>Sign in</title>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("runtimeApiProbeUrl", () => {
  it("targets the health route on the origin, dropping any configured path", () => {
    expect(runtimeApiProbeUrl("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100/api/health");
    expect(runtimeApiProbeUrl("https://board.example.com/some/path?q=1")).toBe(
      "https://board.example.com/api/health",
    );
  });

  it("returns null for a value that is not an absolute URL", () => {
    expect(runtimeApiProbeUrl("127.0.0.1:3100")).toBeNull();
    expect(runtimeApiProbeUrl("")).toBeNull();
  });
});

describe("probeRuntimeApiUrl", () => {
  it("accepts the redacted health response an unauthenticated caller gets", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "authenticated", commit: null }));

    const result = await probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:3100/api/health");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("accepts the full-detail health response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "ok",
        version: "2026.9.1",
        serverVersion: "2026.9.1",
        commit: "abc123",
        serverInfo: { git: { available: false } },
      }),
    );

    await expect(probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any })).resolves.toEqual({
      ok: true,
      status: 200,
    });
  });

  it("accepts an unhealthy JSON response — the probe checks routing, not health", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { status: "unhealthy", serverVersion: "2026.9.1", error: "database_unreachable" },
          { status: 503 },
        ),
      );

    await expect(probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any })).resolves.toEqual({
      ok: true,
      status: 503,
    });
  });

  it("rejects an unrelated service's health route that answers a generic JSON object", async () => {
    // Spawned runs send their bearer run token to whatever origin wins the
    // probe, so a bare `{"status":"ok"}` from some other service must not pass.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", uptime: 41 }));

    const result = await probeRuntimeApiUrl("https://grafana.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not a Paperclip /api/health response");
  });

  it("rejects a JSON object with Paperclip fields but no health status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized", deploymentMode: "cloud" }));

    const result = await probeRuntimeApiUrl("https://board.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not a Paperclip /api/health response");
  });

  it("accepts a board health response whose commit is this build's, when self-identity is required", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "authenticated", commit: "a".repeat(40) }));

    await expect(
      probeRuntimeApiUrl("http://127.0.0.1:3100", {
        fetchImpl: fetchImpl as any,
        requireCommit: "a".repeat(40),
      }),
    ).resolves.toEqual({ ok: true, status: 200 });
  });

  it("rejects a board-shaped response from a different build when self-identity is required", async () => {
    // A fallback origin is this server's own port on its own hostname, so
    // anything reporting another commit is not this server and must not receive
    // spawned runs' bearer tokens.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "authenticated", commit: "b".repeat(40) }));

    const result = await probeRuntimeApiUrl("http://10.0.0.5:3100", {
      fetchImpl: fetchImpl as any,
      requireCommit: "a".repeat(40),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(`reports build commit ${"b".repeat(40)}`);
    expect(result.ok === false && result.reason).toContain(`not this server's ${"a".repeat(40)}`);
  });

  it("rejects a board-shaped response with no commit when self-identity is required", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "cloud", commit: null }));

    const result = await probeRuntimeApiUrl("http://10.0.0.5:3100", {
      fetchImpl: fetchImpl as any,
      requireCommit: "a".repeat(40),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("reports no build commit");
  });

  it("waives the commit check when this server cannot read its own commit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "cloud", commit: null }));

    await expect(
      probeRuntimeApiUrl("http://10.0.0.5:3100", { fetchImpl: fetchImpl as any, requireCommit: null }),
    ).resolves.toEqual({ ok: true, status: 200 });
  });

  it("rejects an auth-proxy origin that answers 200 text/html", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(200));

    const result = await probeRuntimeApiUrl("https://board.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("text/html");
    expect(result.ok === false && result.reason).toContain("instead of JSON");
  });

  it("rejects an auth-proxy origin that redirects to a sign-in page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://auth.example.com/cdn-cgi/access/login" },
      }),
    );

    const result = await probeRuntimeApiUrl("https://board.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("HTTP 302");
    expect(result.ok === false && result.reason).toContain("https://auth.example.com/cdn-cgi/access/login");
  });

  it("rejects a JSON content-type carrying a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<!doctype html>", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const result = await probeRuntimeApiUrl("https://board.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("unparseable body");
  });

  it("rejects a JSON array response, which no API route serves", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([1, 2, 3]));

    const result = await probeRuntimeApiUrl("https://board.example.com", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not an API response object");
  });

  it("rejects an unreachable origin", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3100"));

    const result = await probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("ECONNREFUSED");
  });

  it("rejects a URL that is not absolute without issuing a request", async () => {
    const fetchImpl = vi.fn();

    const result = await probeRuntimeApiUrl("board.example.com", { fetchImpl: fetchImpl as any });

    expect(result).toEqual({ ok: false, reason: "is not a parseable absolute URL" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a hanging origin and names the timeout", async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      }),
    );

    const result = await probeRuntimeApiUrl("http://127.0.0.1:3100", {
      fetchImpl: fetchImpl as any,
      timeoutMs: 5,
    });

    expect(result).toEqual({ ok: false, reason: "did not answer within 5ms" });
  });
});

describe("resolveVerifiedRuntimeApiUrl", () => {
  const ok: RuntimeApiProbeResult = { ok: true, status: 200 };
  const bad = (reason: string): RuntimeApiProbeResult => ({ ok: false, reason });

  it("keeps the configured URL when it answers, without probing any fallback", async () => {
    const probe = vi.fn().mockResolvedValue(ok);

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["http://127.0.0.1:3100"],
      probe,
    });

    expect(resolution).toEqual({
      apiUrl: "https://board.example.com",
      changed: false,
      rejected: [],
      unverified: false,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("falls back to the loopback origin when the configured URL serves HTML", async () => {
    const probe = vi.fn(async (apiUrl: string) =>
      apiUrl === "http://127.0.0.1:3100" ? ok : bad("answered HTTP 200 with content-type text/html instead of JSON"),
    );

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["https://board.example.com", "http://10.0.0.5:3100", "http://127.0.0.1:3100"],
      probe,
    });

    expect(resolution.apiUrl).toBe("http://127.0.0.1:3100");
    expect(resolution.changed).toBe(true);
    expect(resolution.unverified).toBe(false);
    // The configured URL is reported once even though the candidate list repeats it.
    expect(resolution.rejected.map((entry) => entry.apiUrl)).toEqual([
      "https://board.example.com",
      "http://10.0.0.5:3100",
    ]);
    expect(resolution.rejected[0]!.reason).toContain("text/html");
  });

  it("reports every candidate and stays on the configured URL when nothing answers", async () => {
    const probe = vi.fn(async () => bad("could not be reached (connect ECONNREFUSED)"));

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["http://127.0.0.1:3100"],
      probe,
    });

    expect(resolution).toMatchObject({
      apiUrl: "https://board.example.com",
      changed: false,
      unverified: true,
    });
    expect(resolution.rejected.map((entry) => entry.apiUrl)).toEqual([
      "https://board.example.com",
      "http://127.0.0.1:3100",
    ]);
  });

  it("holds fallbacks to this server's commit while leaving the configured URL on the shape check", async () => {
    // The configured URL is the operator's own choice and already reached every
    // run before this check existed, so probing it can only narrow where
    // credentials go. Promoting a fallback is the one path that could widen it.
    const probe = vi.fn(async () => ok);

    await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["http://127.0.0.1:3100"],
      selfCommit: "a".repeat(40),
      probe,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![1]).toEqual({ requireCommit: null });
  });

  it("requires this server's commit of every fallback it promotes", async () => {
    const probe = vi.fn(async (_apiUrl: string, identity: { requireCommit: string | null }) =>
      identity.requireCommit === null ? bad("answered HTTP 200 with content-type text/html instead of JSON") : ok,
    );

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["http://10.0.0.5:3100"],
      selfCommit: "a".repeat(40),
      probe,
    });

    expect(resolution.apiUrl).toBe("http://10.0.0.5:3100");
    expect(resolution.changed).toBe(true);
    expect(probe.mock.calls.map((call) => call[1])).toEqual([
      { requireCommit: null },
      { requireCommit: "a".repeat(40) },
    ]);
  });

  it("waives the fallback commit check when this server cannot read its own commit", async () => {
    const probe = vi.fn(async (apiUrl: string) => (apiUrl === "http://127.0.0.1:3100" ? ok : bad("text/html")));

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["http://127.0.0.1:3100"],
      selfCommit: null,
      probe,
    });

    expect(resolution.apiUrl).toBe("http://127.0.0.1:3100");
    expect(probe.mock.calls[1]![1]).toEqual({ requireCommit: null });
  });

  it("does not re-probe the configured URL under the strict check when the candidate list repeats it", async () => {
    // The candidate list starts with the preferred API URL, so the configured
    // value appears twice. Re-probing it as a fallback would reject an origin
    // the operator explicitly chose.
    const probe = vi.fn(async (_apiUrl: string, identity: { requireCommit: string | null }) =>
      identity.requireCommit === null ? ok : bad("reports no build commit"),
    );

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "https://board.example.com",
      fallbackApiUrls: ["https://board.example.com", "http://127.0.0.1:3100"],
      selfCommit: "a".repeat(40),
      probe,
    });

    expect(resolution.apiUrl).toBe("https://board.example.com");
    expect(resolution.changed).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("skips blank candidates", async () => {
    const probe = vi.fn(async (apiUrl: string) => (apiUrl === "http://127.0.0.1:3100" ? ok : bad("nope")));

    const resolution = await resolveVerifiedRuntimeApiUrl({
      configuredApiUrl: "  ",
      fallbackApiUrls: ["", "   ", "http://127.0.0.1:3100"],
      probe,
    });

    expect(resolution.apiUrl).toBe("http://127.0.0.1:3100");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
