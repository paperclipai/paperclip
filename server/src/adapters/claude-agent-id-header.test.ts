import { describe, expect, it, vi } from "vitest";
import { stampClaudeAgentIdHeader } from "./claude-agent-id-header.js";

type ExecuteCtx = {
  agent?: { id?: string };
  config?: { env?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
};

function recordingInner() {
  const sentinel = Symbol("inner-result");
  const inner = vi.fn((ctx: ExecuteCtx) => Promise.resolve(sentinel));
  return { inner, sentinel };
}

function customHeaders(ctx: ExecuteCtx): string | undefined {
  const value = ctx.config?.env?.ANTHROPIC_CUSTOM_HEADERS;
  return typeof value === "string" ? value : undefined;
}

describe("stampClaudeAgentIdHeader", () => {
  it("merges X-Anthropic-Agent-Id into config.env (the env the adapter forwards)", async () => {
    const { inner, sentinel } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    const result = await wrapped({
      agent: { id: "agent-123" },
      config: { cwd: "/work", env: { EXISTING: "keep" } },
    } as never);

    expect(result).toBe(sentinel);
    const forwarded = inner.mock.calls[0]?.[0] as ExecuteCtx;
    expect(customHeaders(forwarded)).toBe("X-Anthropic-Agent-Id: agent-123");
    // Unrelated config + env entries are preserved.
    expect(forwarded.config?.cwd).toBe("/work");
    expect(forwarded.config?.env?.EXISTING).toBe("keep");
  });

  it("appends to a pre-existing ANTHROPIC_CUSTOM_HEADERS value", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    await wrapped({
      agent: { id: "agent-9" },
      config: { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: abc" } },
    } as never);

    const forwarded = inner.mock.calls[0]?.[0] as ExecuteCtx;
    expect(customHeaders(forwarded)).toBe("X-Trace: abc\nX-Anthropic-Agent-Id: agent-9");
  });

  it("strips CR/LF and bounds length to prevent header injection", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    await wrapped({
      agent: { id: "evil\r\nX-Injected: 1" },
      config: { env: {} },
    } as never);

    const forwarded = inner.mock.calls[0]?.[0] as ExecuteCtx;
    expect(customHeaders(forwarded)).toBe("X-Anthropic-Agent-Id: evilX-Injected: 1");
    expect(customHeaders(forwarded)).not.toContain("\n");
  });

  it("bounds an oversized agent id to 256 characters", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    await wrapped({
      agent: { id: "a".repeat(500) },
      config: { env: {} },
    } as never);

    const forwarded = inner.mock.calls[0]?.[0] as ExecuteCtx;
    expect(customHeaders(forwarded)).toBe(`X-Anthropic-Agent-Id: ${"a".repeat(256)}`);
  });

  it("passes through unchanged when no agent id is available", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    const ctx = { agent: {}, config: { env: { EXISTING: "keep" } } } as never;
    await wrapped(ctx);

    // Same ctx object forwarded; no header added.
    expect(inner.mock.calls[0]?.[0]).toBe(ctx);
    expect(customHeaders(inner.mock.calls[0]?.[0] as ExecuteCtx)).toBeUndefined();
  });

  it("does not append a duplicate when X-Anthropic-Agent-Id is already present", async () => {
    const { inner } = recordingInner();
    const wrapped = stampClaudeAgentIdHeader(inner as never);

    const ctx = {
      agent: { id: "agent-7" },
      config: { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Anthropic-Agent-Id: manual-override" } },
    } as never;
    await wrapped(ctx);

    // Manual override is respected — ctx forwarded untouched.
    expect(inner.mock.calls[0]?.[0]).toBe(ctx);
    expect(customHeaders(inner.mock.calls[0]?.[0] as ExecuteCtx)).toBe(
      "X-Anthropic-Agent-Id: manual-override",
    );
  });
});
