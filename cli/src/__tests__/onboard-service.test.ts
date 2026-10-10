import { describe, expect, it, vi } from "vitest";
import {
  handleOnboardService,
  handoffToOnboardedService,
  isInstallableReleaseVersion,
  resolveOnboardServiceDashboardUrl,
  shouldOfferForegroundStart,
} from "../onboard-service.js";

function dashboardConfig(overrides: {
  host?: string;
  port?: number;
  baseUrlMode?: "auto" | "explicit";
  publicBaseUrl?: string;
} = {}) {
  return {
    server: {
      host: overrides.host ?? "127.0.0.1",
      port: overrides.port ?? 3100,
    },
    auth: {
      baseUrlMode: overrides.baseUrlMode ?? "auto",
      disableSignUp: false,
      ...(overrides.publicBaseUrl ? { publicBaseUrl: overrides.publicBaseUrl } : {}),
    },
  };
}

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

describe("onboarded service dashboard handoff", () => {
  it("resolves a reachable local dashboard URL", () => {
    expect(resolveOnboardServiceDashboardUrl(dashboardConfig({ host: "0.0.0.0", port: 4321 })))
      .toBe("http://127.0.0.1:4321");
    expect(resolveOnboardServiceDashboardUrl(dashboardConfig({ host: "::1" })))
      .toBe("http://[::1]:3100");
  });

  it("uses the configured public URL when auth requires one", () => {
    expect(resolveOnboardServiceDashboardUrl(dashboardConfig({
      baseUrlMode: "explicit",
      publicBaseUrl: "https://paperclip.example.com/",
    }))).toBe("https://paperclip.example.com");
  });

  it("prints the dashboard URL without opening a browser in non-interactive runs", async () => {
    const info = vi.fn();
    const waitUntilReady = vi.fn(async () => ({
      schemaVersion: 1 as const,
      instanceId: "default",
      pid: 123,
      host: "127.0.0.1",
      port: 3100,
      dashboardUrl: "http://127.0.0.1:3100",
      startedAt: "2026-08-25T00:00:00.000Z",
    }));
    const openDashboard = vi.fn(async () => true);

    await handoffToOnboardedService(dashboardConfig(), {
      isInteractive: () => false,
      waitUntilReady,
      openDashboard,
      info,
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:3100"));
    expect(waitUntilReady).toHaveBeenCalledOnce();
    expect(openDashboard).not.toHaveBeenCalled();
  });

  it("uses the ready service runtime port before opening the dashboard", async () => {
    const waitUntilReady = vi.fn(async () => ({
      schemaVersion: 1 as const,
      instanceId: "default",
      pid: 123,
      host: "127.0.0.1",
      port: 3101,
      dashboardUrl: "http://127.0.0.1:3101",
      startedAt: "2026-08-25T00:00:00.000Z",
    }));
    const openDashboard = vi.fn(async () => true);
    const success = vi.fn();

    await handoffToOnboardedService(dashboardConfig(), {
      isInteractive: () => true,
      waitUntilReady,
      openDashboard,
      info: vi.fn(),
      success,
    });

    expect(waitUntilReady).toHaveBeenCalledOnce();
    expect(openDashboard).toHaveBeenCalledWith("http://127.0.0.1:3101");
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Sent"));
  });

  it("keeps the manual link and warns when service health does not become ready", async () => {
    const openDashboard = vi.fn(async () => true);
    const warn = vi.fn();

    await handoffToOnboardedService(dashboardConfig(), {
      isInteractive: () => true,
      waitUntilReady: vi.fn(async () => null),
      openDashboard,
      info: vi.fn(),
      warn,
    });

    expect(openDashboard).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("paperclipai service logs"));
  });
});

describe("shouldOfferForegroundStart", () => {
  const base = { serviceInstalled: false, startAlreadyDecided: false, invokedByRun: false, interactive: true };

  it("offers a foreground start on a plain interactive onboard", () => {
    expect(shouldOfferForegroundStart(base)).toBe(true);
  });

  it("never prompts after the service was installed and started", () => {
    expect(shouldOfferForegroundStart({ ...base, serviceInstalled: true })).toBe(false);
  });

  it("never prompts when the start decision was already made by flags", () => {
    expect(shouldOfferForegroundStart({ ...base, startAlreadyDecided: true })).toBe(false);
  });

  it("never prompts when run itself invoked onboarding", () => {
    expect(shouldOfferForegroundStart({ ...base, invokedByRun: true })).toBe(false);
  });

  it("never prompts without an interactive terminal", () => {
    expect(shouldOfferForegroundStart({ ...base, interactive: false })).toBe(false);
  });
});
