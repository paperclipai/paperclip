import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceCommands } from "../commands/service.js";
import { ensureServiceShim } from "../onboard-service.js";
import { detectServiceManager, type ServiceManager } from "../services/service-manager.js";

vi.mock("../onboard-service.js", () => ({ ensureServiceShim: vi.fn() }));
vi.mock("../services/service-manager.js", () => ({ detectServiceManager: vi.fn() }));

const install = vi.fn(async () => ({ changed: true }));

function runInstall(...args: string[]) {
  const program = new Command();
  registerServiceCommands(program);
  return program.parseAsync(["service", "install", ...args], { from: "user" });
}

describe("service install command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(ensureServiceShim).mockResolvedValue({ ok: true, installedNow: false });
    vi.mocked(detectServiceManager).mockResolvedValue({
      supported: true,
      manager: {
        platform: "systemd",
        serviceName: "paperclipai.service",
        definitionPath: "/service/paperclipai.service",
        install,
      } as unknown as ServiceManager,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("checks the shim before installing and preserves JSON output and start flags", async () => {
    await runInstall("--json", "--no-start-now", "--no-start-on-login");

    expect(ensureServiceShim).toHaveBeenCalledWith({ installIfMissing: false });
    expect(vi.mocked(ensureServiceShim).mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]!);
    expect(install).toHaveBeenCalledWith({ startNow: false, startOnLogin: false });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      installed: true,
      changed: true,
      platform: "systemd",
      serviceName: "paperclipai.service",
      definitionPath: "/service/paperclipai.service",
      lingerEnabled: false,
    }, null, 2));
  });

  it("rejects a missing shim without installing or printing success JSON", async () => {
    vi.mocked(ensureServiceShim).mockResolvedValue({ ok: false, installedNow: false, reason: "missing shim" });

    await expect(runInstall("--json")).rejects.toThrow(
      "Background service not installed: missing shim. Run `paperclipai install`, then `paperclipai service install`.",
    );
    expect(install).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("allows creating the managed shim without --json", async () => {
    await runInstall();

    expect(ensureServiceShim).toHaveBeenCalledWith({ installIfMissing: true });
    expect(install).toHaveBeenCalledWith({ startNow: true, startOnLogin: true });
  });
});
