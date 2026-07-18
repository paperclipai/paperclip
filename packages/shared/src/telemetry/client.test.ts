import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
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
