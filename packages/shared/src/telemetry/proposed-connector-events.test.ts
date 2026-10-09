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

function trackAllProposedConnectorEvents(client: TelemetryClient) {
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

describe("proposed connector events against the real TelemetryClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("cannot queue or send: state stays untouched and nothing hits the wire", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    trackAllProposedConnectorEvents(client);
    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("differential control: a registered event through the same client does send", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    trackAllProposedConnectorEvents(client);
    client.track("project.created", {});
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.events).toEqual([
      expect.objectContaining({ name: "project.created" }),
    ]);
  });

  it("reports the three connector event names as unregistered", () => {
    const { client } = makeClient();
    expect(client.isRegisteredEventName("connection.created")).toBe(false);
    expect(client.isRegisteredEventName("connection.updated")).toBe(false);
    expect(client.isRegisteredEventName("connection.invoked")).toBe(false);
    expect(client.isRegisteredEventName("project.created")).toBe(true);
  });

  it("a disabled client drops even registered events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient({ enabled: false });

    client.track("project.created", {});
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
