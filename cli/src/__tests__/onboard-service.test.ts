import { describe, expect, it, vi } from "vitest";
import { handleOnboardService, isInstallableReleaseVersion } from "../onboard-service.js";

function supportedDetection() {
  return {
    supported: true as const,
    manager: {
      platform: "systemd" as const,
      instanceId: "default",
      serviceName: "paperclipai.service",
      definitionPath: "/tmp/paperclipai.service",
      renderDefinition: () => "unit",
      install: vi.fn(async () => ({ changed: true })),
      uninstall: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      status: vi.fn(async () => ({
        platform: "systemd" as const,
        serviceName: "paperclipai.service",
        installed: true,
        active: true,
        enabled: true,
        pid: 123,
      })),
      logs: vi.fn(async () => undefined),
      installedExecutablePath: vi.fn(async () => null),
    },
  };
}

describe("onboard service policy", () => {
  it("does not install during --yes onboarding without opt-in", async () => {
    const detection = supportedDetection();
    const info = vi.fn();

    const installed = await handleOnboardService(
      { yes: true },
      { detect: vi.fn(async () => detection), isInteractive: () => false, info },
    );

    expect(installed).toBe(false);
    expect(detection.manager.install).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("--install-service"));
  });

  it("installs when --yes explicitly opts in", async () => {
    const detection = supportedDetection();

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => false,
        ensureServiceShim: vi.fn(async () => ({ ok: true, installedNow: false })),
      },
    );

    expect(installed).toBe(true);
    expect(detection.manager.install).toHaveBeenCalledWith({ startNow: true, startOnLogin: true });
  });

  it("asks during interactive onboarding", async () => {
    const detection = supportedDetection();
    const confirm = vi.fn(async () => true);

    const installed = await handleOnboardService(
      {},
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => true,
        confirm,
        ensureServiceShim: vi.fn(async () => ({ ok: true, installedNow: false })),
      },
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(installed).toBe(true);
  });

  it("silences the hint with --no-install-service", async () => {
    const info = vi.fn();
    const detect = vi.fn(async () => supportedDetection());

    const installed = await handleOnboardService(
      { yes: true, installService: false },
      { detect, isInteractive: () => false, info },
    );

    expect(installed).toBe(false);
    expect(detect).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("materializes the managed shim before installing the service", async () => {
    const detection = supportedDetection();
    const success = vi.fn();
    const ensureServiceShim = vi.fn(async () => ({ ok: true, installedNow: true }));

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      { detect: vi.fn(async () => detection), isInteractive: () => false, ensureServiceShim, success },
    );

    expect(installed).toBe(true);
    expect(ensureServiceShim).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith(expect.stringContaining("managed paperclipai payload"));
    expect(detection.manager.install).toHaveBeenCalledWith({ startNow: true, startOnLogin: true });
  });

  it("declines instead of installing a service without a binary", async () => {
    const detection = supportedDetection();
    const warn = vi.fn();

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => false,
        ensureServiceShim: vi.fn(async () => ({ ok: false, installedNow: false, reason: "npm exploded" })),
        warn,
      },
    );

    expect(installed).toBe(false);
    expect(detection.manager.install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("npm exploded"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("paperclipai install"));
  });

});

describe("isInstallableReleaseVersion", () => {
  it("accepts calendar releases and rejects placeholders", () => {
    expect(isInstallableReleaseVersion("2026.824.1")).toBe(true);
    expect(isInstallableReleaseVersion("2026.818.0-beta.1")).toBe(true);
    expect(isInstallableReleaseVersion("0.3.1")).toBe(false);
    expect(isInstallableReleaseVersion("not-a-version")).toBe(false);
  });
});
