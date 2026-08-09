import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  bindSessionRunIdOnServer,
  buildAgentParams,
  buildPaperclipApiFetch,
  clearSessionRunIdOnServer,
  readClaimedApiKey,
  resolveClaimedApiKeyPath,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});

describe("buildPaperclipApiFetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeCtx(paperclipApiUrl: string | null): AdapterExecutionContext {
    return {
      runId: "run-abc-123",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Van Dam",
        adapterType: "openclaw_gateway",
        adapterConfig: {},
      },
      runtime: {} as AdapterExecutionContext["runtime"],
      config: paperclipApiUrl === null ? {} : { paperclipApiUrl },
      context: {},
      onLog: async () => {},
    };
  }

  function recordedHeaders(): Array<Headers> {
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls.map(([input, init]) => {
      const req = input instanceof Request ? input : new Request(input as string, init);
      return req.headers;
    });
  }

  it("injects X-Paperclip-Run-Id on Paperclip-API calls and omits it on third-party URLs", async () => {
    const fetchFn = buildPaperclipApiFetch(makeCtx("http://10.0.0.100:3100/"));

    await fetchFn("http://10.0.0.100:3100/api/agents/me");
    await fetchFn("https://example.com/api/webhook");

    const headers = recordedHeaders();
    expect(headers[0].get("x-paperclip-run-id")).toBe("run-abc-123");
    expect(headers[1].get("x-paperclip-run-id")).toBeNull();
  });

  it("preserves an explicit caller-supplied X-Paperclip-Run-Id (case-insensitive)", async () => {
    const fetchFn = buildPaperclipApiFetch(makeCtx("http://10.0.0.100:3100/"));

    await fetchFn("http://10.0.0.100:3100/api/issues/PHA-1673", {
      method: "PATCH",
      headers: { "X-PAPERCLIP-RUN-ID": "caller-run-xyz" },
    });
    await fetchFn("http://10.0.0.100:3100/api/issues/PHA-1673", {
      method: "PATCH",
      headers: [["x-paperclip-run-id", "caller-run-abc"]],
    });

    const headers = recordedHeaders();
    expect(headers[0].get("x-paperclip-run-id")).toBe("caller-run-xyz");
    expect(headers[1].get("x-paperclip-run-id")).toBe("caller-run-abc");
  });

  it("does not inject when no paperclipApiUrl is configured", async () => {
    const fetchFn = buildPaperclipApiFetch(makeCtx(null));

    await fetchFn("http://10.0.0.100:3100/api/agents/me");

    const headers = recordedHeaders();
    expect(headers[0].get("x-paperclip-run-id")).toBeNull();
  });
});

describe("bindSessionRunIdOnServer", () => {
  function makeFetch(responses: Array<{ status: number; body?: string } | Error>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[i++] ?? { status: 200, body: "{}" };
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "{}", { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("PUTs the runId to /api/agents/me/api-key/session-bind with bearer auth", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: '{"ok":true}' }]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100/",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.0.0.100:3100/api/agents/me/api-key/session-bind");
    expect(calls[0].init.method).toBe("PUT");
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer pcp_test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      runId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("returns ok:false when the server returns non-2xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 503, body: "down" }]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/503/);
    }
  });

  it("returns ok:false when the fetch throws", async () => {
    const { fetchImpl } = makeFetch([new Error("ECONNREFUSED")]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it("returns ok:false on invalid paperclipApiUrl", async () => {
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "not a url",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
  });

  it("aborts on timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
  });
});

describe("clearSessionRunIdOnServer", () => {
  function makeFetch(responses: Array<{ status: number; body?: string } | Error>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[i++] ?? { status: 200, body: "{}" };
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "{}", { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("DELETEs the session-bind endpoint with the matching runId", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);
    const result = await clearSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100/",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.0.0.100:3100/api/agents/me/api-key/session-bind");
    expect(calls[0].init.method).toBe("DELETE");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      runId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("treats 404 as ok (binding was already cleared)", async () => {
    const { fetchImpl } = makeFetch([{ status: 404 }]);
    const result = await clearSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
  });
});

describe("readClaimedApiKey", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads a valid claimed-api-key JSON file", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(
      file,
      JSON.stringify({
        token: "pcp_test_token",
        agentId: "agent-1",
        companyId: "company-1",
        claimedAt: "2026-08-01T00:00:00Z",
      }),
    );
    const result = await readClaimedApiKey(file);
    expect(result).toEqual({
      token: "pcp_test_token",
      agentId: "agent-1",
      companyId: "company-1",
    });
  });

  it("returns null when the file does not exist", async () => {
    const result = await readClaimedApiKey("/no/such/file.json");
    expect(result).toBeNull();
  });

  it("returns null when the file is not valid JSON", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(file, "{not valid json");
    const result = await readClaimedApiKey(file);
    expect(result).toBeNull();
  });

  it("returns null when the file is missing required fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(file, JSON.stringify({ token: "pcp_test" }));
    const result = await readClaimedApiKey(file);
    expect(result).toBeNull();
  });

  it("expands a leading tilde to the home directory", async () => {
    // Don't actually write to $HOME — just verify the path expansion logic
    // by passing a path under $HOME that doesn't exist.
    const home = process.env.HOME ?? "";
    if (!home) return; // skip on platforms without HOME
    const result = await readClaimedApiKey(`~/${Math.random()}-does-not-exist.json`);
    expect(result).toBeNull();
  });
});
