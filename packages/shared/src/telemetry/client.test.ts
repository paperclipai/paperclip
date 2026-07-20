import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import type { TelemetryConfig, TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(stateFactory = vi.fn(() => TEST_STATE), config?: Partial<TelemetryConfig>) {
  return {
    client: new TelemetryClient(
      { enabled: true, endpoint: "http://localhost:9999/ingest", ...config },
      stateFactory,
      "0.0.0-test",
    ),
    stateFactory,
  };
}

function sentBody() {
  const requestInit = vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(requestInit?.body ?? "{}"));
}

describe("TelemetryClient runtime event gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows proposed first-party events before they touch state or the queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    client.track(
      // @ts-expect-error -- proposed-telemetry(PAP-2411): fixture proposal not in generated schema
      "skill_studio.skill_created",
      { sharing_scope: "team" },
    );

    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses own-property membership so prototype event names are swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    // @ts-expect-error constructor is grammar-valid but not a registered Paperclip event.
    client.track("constructor", {});
    // @ts-expect-error toString is grammar-valid but not a registered Paperclip event.
    client.track("toString", {});

    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps registered event batches unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    client.track("install.started", {});
    await client.flush();

    expect(stateFactory).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({
      app: "paperclip",
      schemaVersion: "1",
      installId: "test-install",
      version: "0.0.0-test",
      events: [
        {
          name: "install.started",
          dimensions: {},
        },
      ],
    });
    expect(sentBody().events[0]?.occurredAt).toEqual(expect.any(String));
  });

  it("does not change trackDynamic plugin emission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.trackDynamic("plugin.linear.sync_completed", { status: "ok" });
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBody().events).toEqual([
      expect.objectContaining({
        name: "plugin.linear.sync_completed",
        dimensions: { status: "ok" },
      }),
    ]);
  });
});

// Stubs `fetch` to reject the batch with a given non-OK HTTP status for every
// endpoint the client may try. Returns the mock so call counts can be asserted.
function stubFetchStatus(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Phase 1 (PAP-2862): characterization pins for today's best-effort, silent-drop
// flush. On ANY non-OK response or network error the drained batch is dropped
// with no re-queue and no second attempt, and no `batchId` is emitted. These pins
// lock the current baseline; Impl-2 (PAP-2853) replaces them when retry lands.
describe("TelemetryClient silent-drop baseline (characterization)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops the batch on a 429 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(429);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Queue was drained despite the failure: a second flush sends nothing.
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on a 413 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(413);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on a 400 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(400);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on network error with no re-queue", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits no batchId today", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBody()).not.toHaveProperty("batchId");
  });
});

// Phase 2 (PAP-2862): config surface for soft caps + backoff. Fields are optional
// and additive; `resolveTelemetryConfig` fills documented defaults centrally so no
// existing caller changes behavior. Nothing reads these yet — Impl-2 is the first
// consumer.
describe("resolveTelemetryConfig caps + backoff surface", () => {
  it("resolveTelemetryConfig returns default caps and backoff", () => {
    const config = resolveTelemetryConfig();

    expect(config.maxEventsPerBatch).toBe(50);
    expect(config.maxBodyBytes).toBe(524288);
    expect(config.maxPendingRetryBatches).toBe(20);
    expect(config.backoff).toEqual({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxAttempts: 5,
      jitterRatio: 0.25,
    });
  });

  it("honors caps/backoff overrides", () => {
    const config = resolveTelemetryConfig({
      maxEventsPerBatch: 10,
      maxBodyBytes: 1024,
      maxPendingRetryBatches: 3,
      backoff: {
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        maxAttempts: 2,
        jitterRatio: 0.1,
      },
    });

    expect(config.maxEventsPerBatch).toBe(10);
    expect(config.maxBodyBytes).toBe(1024);
    expect(config.maxPendingRetryBatches).toBe(3);
    expect(config.backoff).toEqual({
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      maxAttempts: 2,
      jitterRatio: 0.1,
    });
  });
});
