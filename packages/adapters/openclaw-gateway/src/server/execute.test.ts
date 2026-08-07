import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildAgentParams,
  buildPaperclipApiFetch,
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
