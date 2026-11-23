import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn<() => Promise<"active" | "suspended" | "removed" | "unknown_instance">>(),
}));

vi.mock("../services/paperclip-cloud-connector-enrollment.js", () => ({
  paperclipCloudConnectorEnrollmentStatus: () => ({
    configured: true, status: "active", brokerBaseUrl: "https://broker.example", instanceId: "instance-1", environment: "development", origins: [],
  }),
}));

vi.mock("../services/paperclip-cloud-connector.js", () => ({
  paperclipCloudConnectorConfigFromEnv: () => ({}),
  createPaperclipCloudConnector: () => ({ getConfirmedInstanceStatus: mocks.status }),
}));

const { reconcilePaperclipCloudConnectorEnrollmentStatus } = await import("../services/paperclip-cloud-connector-status.js");

describe("reconcilePaperclipCloudConnectorEnrollmentStatus", () => {
  beforeEach(() => mocks.status.mockReset());

  it("ends Google access when Paperclip Cloud reports the instance removed", async () => {
    mocks.status.mockResolvedValue("removed");
    const onRemoved = vi.fn(async () => 1);

    const status = await reconcilePaperclipCloudConnectorEnrollmentStatus({}, fetch, onRemoved);

    expect(status.status).toBe("not_configured");
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it.each(["active", "suspended", "unknown_instance"] as const)("does not end Google access when the status is %s", async (value) => {
    mocks.status.mockResolvedValue(value);
    const onRemoved = vi.fn(async () => 1);

    await reconcilePaperclipCloudConnectorEnrollmentStatus({}, fetch, onRemoved);

    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("still reports the status when ending Google access fails", async () => {
    mocks.status.mockResolvedValue("removed");

    const status = await reconcilePaperclipCloudConnectorEnrollmentStatus({}, fetch, async () => { throw new Error("queue failed"); });

    expect(status.status).toBe("not_configured");
  });
});
