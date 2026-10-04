import { beforeEach, describe, expect, it, vi } from "vitest";

const restartManagedService = vi.fn(async () => ({
  status: { active: true },
  health: { ok: true, serverVersion: "1.0.0" },
  report: null,
}));

type StatusStub = { active: boolean; pid: number | null; serviceName: string };
const status = vi.fn(async (): Promise<StatusStub> => ({ active: true, pid: 1, serviceName: "paperclip" }));
const detectServiceManager = vi.fn(async () => ({
  supported: true as const,
  manager: { status, restart: vi.fn() },
}));

vi.mock("../commands/service.js", () => ({ restartManagedService }));
vi.mock("../services/service-manager.js", () => ({ detectServiceManager }));
vi.mock("../config/home.js", () => ({
  resolvePaperclipInstanceId: () => "default",
  resolvePaperclipInstanceRoot: () => "/tmp/paperclip-test",
}));

describe("restartActiveManagedService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({ active: true, pid: 1, serviceName: "paperclip" });
    detectServiceManager.mockResolvedValue({
      supported: true as const,
      manager: { status, restart: vi.fn() },
    });
  });

  it("passes waitForDrain: true to restartManagedService", async () => {
    const { restartActiveManagedService } = await import("../commands/update.js");
    await expect(restartActiveManagedService("1.2.3")).resolves.toBe(true);
    expect(restartManagedService).toHaveBeenCalledWith({
      instanceId: "default",
      expectedVersion: "1.2.3",
      waitForDrain: true,
    });
  });

  it("skips restart when the managed service is inactive", async () => {
    status.mockResolvedValue({ active: false, pid: null, serviceName: "paperclip" });
    const { restartActiveManagedService } = await import("../commands/update.js");
    await expect(restartActiveManagedService("1.2.3")).resolves.toBe(false);
    expect(restartManagedService).not.toHaveBeenCalled();
  });
});
