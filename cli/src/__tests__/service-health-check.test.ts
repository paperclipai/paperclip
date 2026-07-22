import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serviceHealthChecks } from "../checks/service-health-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const config = {
  server: { host: "127.0.0.1", port: 3100 },
} as PaperclipConfig;

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
