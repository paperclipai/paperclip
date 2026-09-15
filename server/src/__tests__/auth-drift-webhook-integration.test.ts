import { describe, expect, it, vi } from "vitest";
import {
  createAuthDriftWebhookDispatcher,
  handleAuthDriftMeta,
  type AuthDriftRunEventAppender,
} from "../services/auth-drift-webhook.js";

// ROCAA-21 integration test: when the heartbeat appends an `adapter.auth_drift`
// run event via the helper, the OPS webhook MUST also be POSTed. We use the
// real dispatcher (with a stubbed fetch + zero retry/debounce delays) and a
// recording `appendRunEvent` to verify the end-to-end shape.

describe("auth-drift integration: heartbeat helper + dispatcher", () => {
  it("fires the OPS webhook when the run event is appended", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      debounceMs: 0,
      maxAttempts: 1,
      sleep: async () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const appendedEvents: Array<{
      eventType: string;
      level?: string;
      payload?: Record<string, unknown>;
    }> = [];
    const appendRunEvent: AuthDriftRunEventAppender = async (event) => {
      appendedEvents.push({
        eventType: event.eventType,
        level: event.level,
        payload: event.payload,
      });
    };

    await handleAuthDriftMeta({
      meta: {
        adapterType: "claude_local",
        command: "/usr/local/bin/claude",
        commandArgs: ["--api-key=sk-very-secret", "--workdir", "/tmp/wt"],
        authDriftDetected: true,
        authSource: "api",
        authDriftReasons: ["ANTHROPIC_API_KEY env var set"],
      },
      agent: { id: "agent_b09dd966", name: "Security & Performance", companyId: "co_rocaa" },
      runId: "run_abc",
      appendRunEvent,
      dispatcher,
    });

    // 1. Run event must have been appended exactly once with the expected shape.
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]).toMatchObject({
      eventType: "adapter.auth_drift",
      level: "warn",
      payload: {
        adapterType: "claude_local",
        agentId: "agent_b09dd966",
        runId: "run_abc",
        authSource: "api",
        reasons: ["ANTHROPIC_API_KEY env var set"],
      },
    });

    // dispatch() is fire-and-forget. Drain the microtask queue so the
    // underlying send() runs before we assert on fetch.
    await new Promise((resolve) => setImmediate(resolve));

    // 2. Webhook was POSTed to the configured URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe("https://hooks.example/ops");
    const req = init as RequestInit;
    expect(req.method).toBe("POST");
    expect(req.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(req.body as string);

    // 3. Payload contains the redacted detail and never the raw secret.
    expect(JSON.stringify(body)).not.toContain("sk-very-secret");
    expect(body.paperclip).toMatchObject({
      eventType: "adapter.auth_drift",
      companyId: "co_rocaa",
      adapterType: "claude_local",
      agentId: "agent_b09dd966",
      agentName: "Security & Performance",
      runId: "run_abc",
      authSource: "api",
      reasons: ["ANTHROPIC_API_KEY env var set"],
    });
    expect(body.paperclip.commandArgs).toEqual([
      "--api-key=***REDACTED***",
      "--workdir",
      "/tmp/wt",
    ]);
  });

  it("does not POST when the dispatcher is unconfigured (no OPS URL)", async () => {
    const fetchImpl = vi.fn();
    const dispatcher = createAuthDriftWebhookDispatcher({
      // url omitted -> disabled
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const appendRunEvent = vi.fn(async () => undefined);

    await handleAuthDriftMeta({
      meta: {
        adapterType: "claude_local",
        command: "/usr/local/bin/claude",
        authDriftDetected: true,
        authSource: "api",
        authDriftReasons: ["ANTHROPIC_API_KEY env var set"],
      },
      agent: { id: "a", companyId: "c" },
      runId: "r",
      appendRunEvent,
      dispatcher,
    });

    // Run event still fires (observability is decoupled from delivery), but
    // the webhook does not.
    expect(appendRunEvent).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
