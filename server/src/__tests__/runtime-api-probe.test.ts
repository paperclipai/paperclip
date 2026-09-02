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
  it("accepts a JSON object response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", commit: null }));

    const result = await probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:3100/api/health");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("accepts an unhealthy JSON response — the probe checks routing, not health", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "unhealthy" }, { status: 503 }));

    await expect(probeRuntimeApiUrl("http://127.0.0.1:3100", { fetchImpl: fetchImpl as any })).resolves.toEqual({
      ok: true,
      status: 503,
    });
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
