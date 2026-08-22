import { describe, expect, it, vi } from "vitest";
import {
  buildSlackWebhookBody,
  createAuthDriftWebhookDispatcher,
  handleAuthDriftMeta,
  type AuthDriftWebhookLogger,
  type AuthDriftWebhookPayload,
} from "../services/auth-drift-webhook.js";

function silentLogger(): AuthDriftWebhookLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function samplePayload(overrides: Partial<AuthDriftWebhookPayload> = {}): AuthDriftWebhookPayload {
  return {
    companyId: "co_1",
    adapterType: "claude_local",
    agentId: "agent_1",
    agentName: "Security & Performance",
    runId: "run_1",
    authSource: "api",
    reasons: ["ANTHROPIC_API_KEY env var set"],
    command: "/usr/local/bin/claude",
    commandArgs: ["--api-key=sk-leak", "--workdir", "/tmp"],
    ...overrides,
  };
}

describe("buildSlackWebhookBody", () => {
  it("redacts --api-key= argv values and never exposes env", () => {
    const body = buildSlackWebhookBody(samplePayload());
    const json = JSON.stringify(body);
    expect(json).not.toContain("sk-leak");
    expect(body.paperclip.commandArgs).toEqual([
      "--api-key=***REDACTED***",
      "--workdir",
      "/tmp",
    ]);
    // Slack-shaped surface.
    expect(body.text).toContain("Auth-source drift");
    expect(body.attachments[0]).toMatchObject({ color: "warning" });
    // Raw paperclip payload includes the event type so downstream consumers
    // can route on the same key as the run event.
    expect(body.paperclip.eventType).toBe("adapter.auth_drift");
  });

  it("masks the token after space-separated --api-key flags", () => {
    const body = buildSlackWebhookBody(
      samplePayload({ commandArgs: ["--api-key", "sk-secret", "--workdir", "/tmp"] }),
    );
    expect(body.paperclip.commandArgs).toEqual([
      "--api-key",
      "***REDACTED***",
      "--workdir",
      "/tmp",
    ]);
  });
});

describe("createAuthDriftWebhookDispatcher", () => {
  it("is disabled and dispatch is a no-op when no URL is configured", async () => {
    const fetchImpl = vi.fn();
    const dispatcher = createAuthDriftWebhookDispatcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLogger(),
    });
    expect(dispatcher.enabled).toBe(false);
    dispatcher.dispatch(samplePayload());
    await expect(dispatcher.dispatchAndWait(samplePayload())).resolves.toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the Slack body and reports 'sent' on 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLogger(),
      debounceMs: 0,
    });
    const outcome = await dispatcher.dispatchAndWait(samplePayload());
    expect(outcome).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/ops");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.paperclip.eventType).toBe("adapter.auth_drift");
    expect(body.paperclip.agentId).toBe("agent_1");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("debounces repeat events within the window, by (company,agent,adapter,reasons)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    let nowMs = 1_000_000;
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLogger(),
      debounceMs: 60_000,
      now: () => nowMs,
    });
    await dispatcher.dispatchAndWait(samplePayload());
    nowMs += 1000;
    const second = await dispatcher.dispatchAndWait(samplePayload());
    expect(second).toBe("debounced");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the window expires, the same key fires again.
    nowMs += 60_000;
    const third = await dispatcher.dispatchAndWait(samplePayload());
    expect(third).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A different (agent or reasons) tuple is not debounced.
    nowMs += 1;
    const other = await dispatcher.dispatchAndWait(samplePayload({ agentId: "agent_2" }));
    expect(other).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on failure up to maxAttempts and reports 'failed' when exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("nope", { status: 502 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLogger(),
      debounceMs: 0,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      sleep,
    });
    const outcome = await dispatcher.dispatchAndWait(samplePayload());
    expect(outcome).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries network errors and reports 'sent' once the upstream recovers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLogger(),
      debounceMs: 0,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      sleep: async () => undefined,
    });
    const outcome = await dispatcher.dispatchAndWait(samplePayload());
    expect(outcome).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts the underlying fetch when the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        // Wait until the dispatcher aborts. The signal is wired by the dispatcher.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        });
      });
      const dispatcher = createAuthDriftWebhookDispatcher({
        url: "https://hooks.example/ops",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: silentLogger(),
        debounceMs: 0,
        timeoutMs: 50,
        maxAttempts: 1,
        sleep: async () => undefined,
      });
      const promise = dispatcher.dispatchAndWait(samplePayload());
      await vi.advanceTimersByTimeAsync(60);
      const outcome = await promise;
      expect(outcome).toBe("failed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatch() never rejects even when delivery throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const errors: Array<Record<string, unknown>> = [];
    const dispatcher = createAuthDriftWebhookDispatcher({
      url: "https://hooks.example/ops",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (meta) => {
          errors.push(meta);
        },
      },
      debounceMs: 0,
      maxAttempts: 1,
    });
    // Fire-and-forget API.
    dispatcher.dispatch(samplePayload());
    // Let any microtasks settle so the underlying send() rejection is caught
    // by the dispatcher's catch handler.
    await new Promise((resolve) => setImmediate(resolve));
    // The error path inside send() reports "failed" instead of throwing, so
    // the .catch in dispatch() should never see anything — but the test
    // still confirms no unhandled rejection escapes.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("handleAuthDriftMeta", () => {
  it("is a no-op when authDriftDetected is false", async () => {
    const appendRunEvent = vi.fn();
    const dispatch = vi.fn();
    await handleAuthDriftMeta({
      meta: { adapterType: "claude_local", command: "/x", authDriftDetected: false },
      agent: { id: "a", name: "A", companyId: "c" },
      runId: "r",
      appendRunEvent,
      dispatcher: {
        enabled: true,
        dispatch,
        dispatchAndWait: async () => "disabled",
        resetDebounce: () => undefined,
      },
    });
    expect(appendRunEvent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("appends the run event and dispatches with redacted-friendly fields", async () => {
    const appendRunEvent = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    await handleAuthDriftMeta({
      meta: {
        adapterType: "codex_local",
        command: "/usr/local/bin/codex",
        commandArgs: ["--api-key=sk-leak"],
        authDriftDetected: true,
        authSource: "api",
        authDriftReasons: ["OPENAI_API_KEY env var set"],
      },
      agent: { id: "agent_42", name: "Codex", companyId: "co_1" },
      runId: "run_xyz",
      appendRunEvent,
      dispatcher: {
        enabled: true,
        dispatch,
        dispatchAndWait: async () => "sent",
        resetDebounce: () => undefined,
      },
    });

    expect(appendRunEvent).toHaveBeenCalledTimes(1);
    const event = appendRunEvent.mock.calls[0]![0];
    expect(event.eventType).toBe("adapter.auth_drift");
    expect(event.level).toBe("warn");
    expect(event.payload).toMatchObject({
      adapterType: "codex_local",
      authSource: "api",
      agentId: "agent_42",
      runId: "run_xyz",
      reasons: ["OPENAI_API_KEY env var set"],
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const payload = dispatch.mock.calls[0]![0];
    expect(payload).toMatchObject({
      companyId: "co_1",
      adapterType: "codex_local",
      agentId: "agent_42",
      agentName: "Codex",
      runId: "run_xyz",
      authSource: "api",
      reasons: ["OPENAI_API_KEY env var set"],
      commandArgs: ["--api-key=sk-leak"],
    });
  });

  it("prefers meta.agentId over agent.id when both are present", async () => {
    const appendRunEvent = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    await handleAuthDriftMeta({
      meta: {
        adapterType: "claude_local",
        command: "/usr/local/bin/claude",
        authDriftDetected: true,
        agentId: "override_agent",
      },
      agent: { id: "outer_agent", companyId: "co_1" },
      runId: "run_1",
      appendRunEvent,
      dispatcher: {
        enabled: true,
        dispatch,
        dispatchAndWait: async () => "sent",
        resetDebounce: () => undefined,
      },
    });
    expect(dispatch.mock.calls[0]![0].agentId).toBe("override_agent");
    expect(appendRunEvent.mock.calls[0]![0].payload).toMatchObject({ agentId: "override_agent" });
  });
});
