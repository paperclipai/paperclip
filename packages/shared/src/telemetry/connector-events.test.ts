import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import {
  trackConnectionCreated,
  trackConnectionUpdated,
  trackConnectionInvoked,
} from "./events.js";
import type { TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(config?: { enabled?: boolean }) {
  const stateFactory = vi.fn(() => TEST_STATE);
  return {
    client: new TelemetryClient(
      { enabled: config?.enabled ?? true, endpoint: "http://localhost:9999/ingest" },
      stateFactory,
      "0.0.0-test",
      () => 0.5,
    ),
    stateFactory,
  };
}

function trackAllConnectorEvents(client: TelemetryClient) {
  trackConnectionCreated(client, {
    connector_key: "github",
    transport: "mcp_remote",
    auth_kind: "oauth",
    setup_flow: "gallery",
    status: "active",
    enabled: true,
  });
  trackConnectionUpdated(client, {
    connector_key: "github",
    transport: "mcp_remote",
    auth_kind: "oauth",
    change_source: "api",
    previous_status: "draft",
    status: "active",
    previous_enabled: false,
    enabled: true,
  });
  trackConnectionInvoked(client, {
    connector_key: "github",
    transport: "mcp_remote",
    status: "succeeded",
    origin: "agent",
    duration_seconds: 3,
  });
}

describe("registered connector events against the real TelemetryClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("queues and sends the three connector events with their exact dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    trackAllConnectorEvents(client);
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.events).toEqual([
      expect.objectContaining({
        name: "connection.created",
        dimensions: {
          connector_key: "github",
          transport: "mcp_remote",
          auth_kind: "oauth",
          setup_flow: "gallery",
          status: "active",
          enabled: true,
        },
      }),
      expect.objectContaining({
        name: "connection.updated",
        dimensions: {
          connector_key: "github",
          transport: "mcp_remote",
          auth_kind: "oauth",
          change_source: "api",
          previous_status: "draft",
          status: "active",
          previous_enabled: false,
          enabled: true,
        },
      }),
      expect.objectContaining({
        name: "connection.invoked",
        dimensions: {
          connector_key: "github",
          transport: "mcp_remote",
          status: "succeeded",
          origin: "agent",
          duration_seconds: 3,
        },
      }),
    ]);
  });

  it("reports the three connector event names as registered", () => {
    const { client } = makeClient();
    expect(client.isRegisteredEventName("connection.created")).toBe(true);
    expect(client.isRegisteredEventName("connection.updated")).toBe(true);
    expect(client.isRegisteredEventName("connection.invoked")).toBe(true);
    expect(client.isRegisteredEventName("project.created")).toBe(true);
  });

  it("a disabled client drops connector events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient({ enabled: false });

    trackAllConnectorEvents(client);
    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("environment suppression resolves telemetry off under CI and opt-out flags", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "1");
    expect(resolveTelemetryConfig().enabled).toBe(false);
    vi.unstubAllEnvs();

    vi.stubEnv("DO_NOT_TRACK", "1");
    expect(resolveTelemetryConfig().enabled).toBe(false);
    vi.unstubAllEnvs();

    vi.stubEnv("GITHUB_ACTIONS", "true");
    expect(resolveTelemetryConfig().enabled).toBe(false);
  });
});
