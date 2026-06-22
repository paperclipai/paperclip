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

  function createTelemetryServices() {
    return buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );
  }

  it("prefixes plugin telemetry events before forwarding them to the telemetry client", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });

    const services = createTelemetryServices();
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

    const services = createTelemetryServices();

    await expect(
      services.telemetry.track({ eventName: "sync.completed" }),
    ).rejects.toThrow(
      'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".',
    );
  });

  it("rejects telemetry tracking when the plugin lacks the capability", async () => {
    const services = createTelemetryServices();
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
    const services = createTelemetryServices();
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

  it("rejects raw private dimension keys before telemetry egress", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });
    const services = createTelemetryServices();
    const rejectedKeys = [
      "company_id",
      "agentId",
      "issue_url",
      "email",
      "token",
      "path",
      "prompt",
      "message",
      "userid",
      "companyid",
      "hostname",
    ];

    for (const key of rejectedKeys) {
      await expect(
        services.telemetry.track({
          eventName: "sync_completed",
          dimensions: { [key]: "manual" },
        }),
      ).rejects.toThrow(/Plugin telemetry dimension|lowercase snake_case/);
    }

    expect(mockGetTelemetryClient).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("allows safe dimension keys that contain sensitive substrings inside unrelated words", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });
    const services = createTelemetryServices();

    await services.telemetry.track({
      eventName: "sync_completed",
      dimensions: {
        script_type: "manual",
        zip_code: "enabled",
        description_mode: "summary",
        hidden: true,
      },
    });

    expect(track).toHaveBeenCalledWith("plugin.linear.sync_completed", {
      script_type: "manual",
      zip_code: "enabled",
      description_mode: "summary",
      hidden: true,
    });
  });

  it("rejects suspicious dimension values before telemetry egress", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });
    const services = createTelemetryServices();
    const rejectedValues = [
      "2f3f5a65-48c8-42f8-967e-b67d4e77f1d2",
      "user@example.com",
      "https://example.com/issues/123",
      "/tmp/paperclip/workspace",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ",
      "0123456789abcdef0123456789abcdef",
    ];

    for (const value of rejectedValues) {
      await expect(
        services.telemetry.track({
          eventName: "sync_completed",
          dimensions: { source: value },
        }),
      ).rejects.toThrow(/must be a short low-cardinality slug|must be 1-64 characters/);
    }

    expect(mockGetTelemetryClient).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("hashes declared private refs server-side before forwarding telemetry", async () => {
    const track = vi.fn();
    const hashPrivateRef = vi.fn((value: string) => `hashed-${value}`);
    mockGetTelemetryClient.mockReturnValue({ track, hashPrivateRef });
    const services = createTelemetryServices();

    await services.telemetry.track({
      eventName: "sync_completed",
      dimensions: { source: "manual", attempts: 2, success: true },
      privateRefs: { company_id: "company-123" },
    });

    expect(hashPrivateRef).toHaveBeenCalledWith("company-123");
    expect(track).toHaveBeenCalledWith("plugin.linear.sync_completed", {
      source: "manual",
      attempts: 2,
      success: true,
      company_id_hashed: "hashed-company-123",
      company_id_is_hashed: true,
    });
  });

  it("rejects private refs that generate colliding telemetry output keys", async () => {
    const track = vi.fn();
    const hashPrivateRef = vi.fn((value: string) => `hashed-${value}`);
    mockGetTelemetryClient.mockReturnValue({ track, hashPrivateRef });
    const services = createTelemetryServices();

    await expect(
      services.telemetry.track({
        eventName: "sync_completed",
        privateRefs: { foo: "v1", foo_is: "v2" },
      }),
    ).rejects.toThrow('Plugin telemetry private ref "foo_is" collides with existing dimensions.');

    expect(hashPrivateRef).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("rejects telemetry events with too many outgoing dimensions", async () => {
    const track = vi.fn();
    mockGetTelemetryClient.mockReturnValue({ track });
    const services = createTelemetryServices();
    const dimensions = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`flag_${index}`, true]),
    );

    await expect(
      services.telemetry.track({
        eventName: "sync_completed",
        dimensions,
      }),
    ).rejects.toThrow("Plugin telemetry events may include at most 20 outgoing dimensions.");

    expect(mockGetTelemetryClient).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});
