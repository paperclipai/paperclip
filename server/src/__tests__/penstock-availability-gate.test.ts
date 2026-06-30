import { describe, expect, it, vi } from "vitest";

import { createPenstockAvailabilityGate } from "../services/penstock-availability-gate.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

function gateWith(fetchImpl: typeof fetch) {
  log.info.mockClear();
  log.warn.mockClear();
  return createPenstockAvailabilityGate({
    fetchImpl,
    log,
    cacheTtlMs: 30_000,
    now: () => new Date("2026-06-30T08:00:00.000Z"),
  });
}

describe("createPenstockAvailabilityGate", () => {
  it("allows adapters that are not Penstock-backed claude_k8s", async () => {
    const fetchMock = vi.fn();
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      adapterConfig: { model: "claude-sonnet-4-6[1m]" },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: {
        ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
        ANTHROPIC_API_KEY: "psk_test",
      },
    });

    expect(result).toEqual({ allow: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a configured Penstock model when the probe returns capacity 429", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error:
            "All subscriptions for provider 'anthropic' are rate-limited; capacity resets at 2026-06-30T08:05:00.000Z; retry in 5s",
        }),
        { status: 429, headers: { "retry-after": "5" } },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: {
          ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" },
        },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 5,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.penstock.run/anthropic/v1/messages");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: "claude-sonnet-4-6[1m]",
      max_tokens: 1,
    });
  });

  it("caches the probe result per endpoint and model", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: "message" }), { status: 200 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);
    const input = {
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    };

    await gate.checkAdapter(input);
    await gate.checkAdapter({ ...input, agentId: "agent-2" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defers for provider-shaped Anthropic 429 without a capacity retry signal", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Error" },
          request_id: "req_011CcZYx",
        }),
        { status: 429 },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 300,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, model: "claude-sonnet-4-6[1m]" }),
      "heartbeat dispatch deferred: penstock model unavailable",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("defers for Penstock auth failures instead of launching doomed runs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_temporarily_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 300,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, model: "claude-sonnet-4-6[1m]" }),
      "heartbeat dispatch deferred: penstock model unavailable",
    );
  });

  it("defers when Penstock reports temporary unavailability", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_temporarily_unavailable",
      model: "claude-opus-4-8[1m]",
      retryAfterSeconds: 300,
    });
    expect(log.info).toHaveBeenCalled();
  });

  it("fails open for unexpected non-capacity probe errors", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toEqual({ allow: true });
    expect(log.warn).toHaveBeenCalled();
  });
});
