import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetryMocks = vi.hoisted(() => {
  const client = {
    startPeriodicFlush: vi.fn(),
  };
  return {
    client,
    trackCloudOrganizationIdentified: vi.fn(),
  };
});

vi.mock("@paperclipai/shared/telemetry", () => ({
  TelemetryClient: vi.fn(function TelemetryClient() {
    return telemetryMocks.client;
  }),
  loadOrCreateState: vi.fn(),
  resolveTelemetryConfig: vi.fn(() => ({ enabled: true })),
  trackCloudOrganizationIdentified: telemetryMocks.trackCloudOrganizationIdentified,
}));

vi.mock("../home-paths.js", () => ({
  resolvePaperclipInstanceRoot: () => "/tmp/paperclip-telemetry-test",
}));

vi.mock("../version.js", () => ({
  serverVersion: "0.0.0-test",
}));

describe("Cloud organization telemetry initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("identifies the organization when a managed Cloud server starts", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-tenant-token");
    vi.stubEnv("PAPERCLIP_CLOUD_ACCOUNT_GROUP_ID", " account-group-1 ");

    const { initTelemetry } = await import("../telemetry.js");
    initTelemetry();

    expect(telemetryMocks.trackCloudOrganizationIdentified).toHaveBeenCalledWith(
      telemetryMocks.client,
      { organization_id: "account-group-1" },
    );
    expect(telemetryMocks.client.startPeriodicFlush).toHaveBeenCalledWith(60_000);
  });

  it("ignores stray organization metadata outside a managed Cloud server", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_ACCOUNT_GROUP_ID", "stray-account-group");

    const { initTelemetry } = await import("../telemetry.js");
    initTelemetry();

    expect(telemetryMocks.trackCloudOrganizationIdentified).not.toHaveBeenCalled();
    expect(telemetryMocks.client.startPeriodicFlush).toHaveBeenCalledWith(60_000);
  });
});
