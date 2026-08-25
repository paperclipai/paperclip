import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceHealthChecks } from "../checks/service-health-check.js";
import { isExecutableFile } from "../services/service-manager.js";
import { resolveRestartExpectedVersion, withHotRestartLock } from "../commands/service.js";
import type { PaperclipConfig } from "../config/schema.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";

const config = {
  server: { host: "127.0.0.1", port: 3100 },
} as PaperclipConfig;

let previousPaperclipHome: string | undefined;
let previousServiceManaged: string | undefined;

beforeEach(() => {
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  previousServiceManaged = process.env.PAPERCLIP_SERVICE_MANAGED;
  process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-service-restart-"));
});

afterEach(() => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  if (previousServiceManaged === undefined) delete process.env.PAPERCLIP_SERVICE_MANAGED;
  else process.env.PAPERCLIP_SERVICE_MANAGED = previousServiceManaged;
});

function managerFixture(active = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-service-doctor-"));
  const definitionPath = path.join(root, "paperclipai.service");
  fs.writeFileSync(definitionPath, "unit");
  return {
    platform: "systemd" as const,
    instanceId: "default",
    serviceName: "paperclipai.service",
    definitionPath,
    renderDefinition: () => "unit",
    install: vi.fn(async () => ({ changed: false })),
    uninstall: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    status: vi.fn(async () => ({
      platform: "systemd" as const,
      serviceName: "paperclipai.service",
      installed: true,
      active,
      enabled: true,
      pid: active ? 123 : null,
      linger: true,
    })),
    logs: vi.fn(async () => undefined),
  };
}

describe("service health doctor checks", () => {
  it("skips live service checks during the managed unit's own activation", async () => {
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    const detect = vi.fn();
    const probe = vi.fn();
    await expect(serviceHealthChecks(config, { detect, probe })).resolves.toEqual([]);
    expect(detect).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("skips exact version matching unless a restart version is explicit", () => {
    expect(resolveRestartExpectedVersion(null)).toBeNull();
    expect(resolveRestartExpectedVersion(undefined)).toBeNull();
    expect(resolveRestartExpectedVersion("1.2.3")).toBe("1.2.3");
  });

  it("serializes concurrent restarts for the same instance", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withHotRestartLock("default", async () => {
      order.push("first-start");
      await firstBlocked;
      order.push("first-end");
    }, { pollMs: 5 });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    const second = withHotRestartLock("default", async () => {
      order.push("second-start");
    }, { pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("reclaims restart locks left by terminated processes", async () => {
    const lockPath = path.join(process.env.PAPERCLIP_HOME!, "instances", "default", "hot-restart.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "424242:stale-token\n");
    const callback = vi.fn(async () => "restarted");

    await expect(withHotRestartLock("default", callback, {
      pollMs: 1,
      timeoutMs: 20,
      isProcessAlive: () => false,
    })).resolves.toBe("restarted");

    expect(callback).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("brackets configured IPv6 hosts in health URLs", () => {
    expect(buildLocalHealthUrl("::1", 3100)).toBe("http://[::1]:3100/api/health");
    expect(buildLocalHealthUrl("::", 3100)).toBe("http://127.0.0.1:3100/api/health");
  });

  it("passes for a current, active, healthy service", async () => {
    const manager = managerFixture();
    const results = await serviceHealthChecks(config, {
      detect: vi.fn(async () => ({ supported: true as const, manager })),
      probe: vi.fn(async () => ({ ok: true, version: "1.2.3" })),
    });

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  it("detects a foreground process on the configured port while the service is inactive", async () => {
    const manager = managerFixture(false);
    const results = await serviceHealthChecks(config, {
      detect: vi.fn(async () => ({ supported: true as const, manager })),
      probe: vi.fn(async () => ({ ok: true, version: "1.2.3" })),
      shimPresent: vi.fn(async () => true),
    });

    expect(results).toContainEqual(
      expect.objectContaining({
        name: "Service runtime",
        status: "fail",
        message: expect.stringContaining("another Paperclip process"),
      }),
    );
  });
});

describe("isExecutableFile", () => {
  it("accepts only executable regular files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-check-"));
    const executable = path.join(dir, "exec");
    const plain = path.join(dir, "plain");
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(plain, "data", { mode: 0o644 });

    await expect(isExecutableFile(executable)).resolves.toBe(true);
    await expect(isExecutableFile(plain)).resolves.toBe(false);
    await expect(isExecutableFile(dir)).resolves.toBe(false);
    await expect(isExecutableFile(path.join(dir, "missing"))).resolves.toBe(false);
  });
});

describe("service runtime shim awareness", () => {
  function inactiveManager() {
    return {
      platform: "launchd" as const,
      instanceId: "default",
      serviceName: "ing.paperclip.paperclipai",
      definitionPath: "/tmp/nonexistent-definition.plist",
      renderDefinition: () => "plist",
      install: vi.fn(async () => ({ changed: false })),
      uninstall: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      status: vi.fn(async () => ({
        platform: "launchd" as const,
        serviceName: "ing.paperclip.paperclipai",
        installed: true,
        active: false,
        enabled: true,
        pid: null,
        detail: "loaded",
      })),
      logs: vi.fn(async () => undefined),
    };
  }

  it("blames the missing binary, not a port conflict, when the shim is gone", async () => {
    const results = await serviceHealthChecks({} as never, {
      detect: vi.fn(async () => ({ supported: true as const, manager: inactiveManager() as never })),
      probe: vi.fn(async () => ({ ok: false, version: null, error: "fetch failed" })),
      shimPresent: vi.fn(async () => false),
    });
    const runtime = results.find((r) => r.name === "Service runtime");
    expect(runtime?.status).toBe("fail");
    expect(runtime?.message).toContain("no executable exists at");
    expect(runtime?.repairHint).toContain("paperclipai install");
  });

  it("points custom PAPERCLIP_SHIM_PATH repairs at the custom path, not paperclipai install", async () => {
    vi.stubEnv("PAPERCLIP_SHIM_PATH", "/custom/bin/paperclipai");
    try {
      const results = await serviceHealthChecks({} as never, {
        detect: vi.fn(async () => ({ supported: true as const, manager: inactiveManager() as never })),
        probe: vi.fn(async () => ({ ok: false, version: null, error: "fetch failed" })),
        shimPresent: vi.fn(async () => false),
      });
      const runtime = results.find((r) => r.name === "Service runtime");
      expect(runtime?.repairHint).toContain("/custom/bin/paperclipai");
      expect(runtime?.repairHint).toContain("PAPERCLIP_SHIM_PATH");
      expect(runtime?.repairHint).toContain("`paperclipai install` followed by `paperclipai service install`");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("attributes a healthy foreign responder instead of reporting Healthy", async () => {
    const results = await serviceHealthChecks({} as never, {
      detect: vi.fn(async () => ({ supported: true as const, manager: inactiveManager() as never })),
      probe: vi.fn(async () => ({ ok: true, version: "9.9.9" })),
      shimPresent: vi.fn(async () => true),
    });
    const healthResult = results.find((r) => r.name === "Service health");
    expect(healthResult?.status).toBe("warn");
    expect(healthResult?.message).toContain("but not from ing.paperclip.paperclipai");
    const runtime = results.find((r) => r.name === "Service runtime");
    expect(runtime?.message).toContain("serving another Paperclip process");
  });
});
