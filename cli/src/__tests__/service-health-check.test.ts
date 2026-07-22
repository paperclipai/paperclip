import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceHealthChecks } from "../checks/service-health-check.js";
import { resolveRestartExpectedVersion, withHotRestartLock } from "../commands/service.js";
import type { PaperclipConfig } from "../config/schema.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";

const config = {
  server: { host: "127.0.0.1", port: 3100 },
} as PaperclipConfig;

let previousPaperclipHome: string | undefined;

beforeEach(() => {
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-service-restart-"));
});

afterEach(() => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
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
