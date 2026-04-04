import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
      };
    },
  } as any;
}

describe("plugin telemetry bridge", () => {
  beforeEach(() => {
    mockGetTelemetryClient.mockReset();
  });

  it("prefixes plugin telemetry events before forwarding them to the telemetry client", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "linear",
      capabilities: ["telemetry.track"],
      services,
    });

    await handlers["telemetry.track"]({
      eventName: "sync_completed",
      dimensions: { attempts: 2, success: true },
    });

    expect(track).toHaveBeenCalledWith("plugin.linear.sync_completed", {
      attempts: 2,
      success: true,
    });
  });

  it("rejects invalid bare telemetry event names before prefixing", async () => {
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );

    await expect(
      services.telemetry.track({ eventName: "sync.completed" }),
    ).rejects.toThrow(
      'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".',
    );
  });

  it("rejects telemetry tracking when the plugin lacks the capability", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "linear",
      capabilities: [],
      services,
    });

    await expect(
      handlers["telemetry.track"]({ eventName: "sync_completed" }),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });

    expect(mockGetTelemetryClient).not.toHaveBeenCalled();
  });

  it("passes telemetry requests through when the plugin declares the capability", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "linear",
      capabilities: ["telemetry.track"],
      services,
    });

    await handlers["telemetry.track"]({
      eventName: "sync_completed",
      dimensions: { source: "manual" },
    });

    expect(mockGetTelemetryClient).toHaveBeenCalledTimes(1);
  });
});
