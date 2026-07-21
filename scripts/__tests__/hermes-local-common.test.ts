import { describe, expect, it } from "vitest";

import {
  buildLocalDoctorReport,
  classifyLocalDoctorReport,
  formatPaperclipStartCommand,
  summarizeLaunchAgents,
  type LocalDoctorInput,
} from "../hermes-local-common.ts";

const baseInput: LocalDoctorInput = {
  apiBase: "http://127.0.0.1:3100/api",
  apiReachable: true,
  authTokenAvailable: true,
  health: { status: "ok", deploymentMode: "authenticated" },
  adapters: [{ type: "hermes_local", loaded: true, disabled: false, modelsCount: 0 }],
  companies: [{ id: "co_1", name: "NFC", status: "active" }],
  selectedCompanyId: "co_1",
  hermesVersion: {
    raw: "Hermes Agent v0.11.0\nPython: 3.14.3",
    versionLine: "Hermes Agent v0.11.0",
    pythonVersion: "3.14.3",
  },
  testEnvironment: {
    adapterType: "hermes_local",
    status: "warn",
    checks: [
      { level: "info", code: "hermes_version", message: "Hermes Agent v0.11.0" },
      { level: "warn", code: "hermes_no_api_keys", message: "No LLM API keys found in environment" },
    ],
  },
  automation: {
    launchAgents: ["io.paperclip.local.service.plist", "io.paperclip.local.healthcheck.plist"],
    serviceLoaded: true,
    healthcheckLoaded: true,
    patchRefreshLoaded: false,
    upstreamUpgradeLoaded: false,
  },
};

describe("Hermes local doctor report", () => {
  it("keeps missing LLM API keys as a non-blocking warning", () => {
    const report = buildLocalDoctorReport(baseInput);

    expect(report.status).toBe("warn");
    expect(report.items.find((item) => item.id === "hermes_no_api_keys")?.severity).toBe("warn");
    expect(report.summary).toMatch(/可用但有非阻塞 warning/);
  });

  it("fails when hermes_local is not registered", () => {
    const report = buildLocalDoctorReport({ ...baseInput, adapters: [] });

    expect(report.status).toBe("fail");
    expect(report.items.find((item) => item.id === "hermes_adapter")?.severity).toBe("fail");
  });

  it("classifies mixed severities by the highest severity", () => {
    expect(classifyLocalDoctorReport(["pass", "warn", "fail"])).toBe("fail");
  });
});

describe("portable local workflow helpers", () => {
  it("formats the start command from the caller repo instead of a personal machine path", () => {
    const command = formatPaperclipStartCommand({
      repoRoot: "/tmp/example paperclip",
      configPath: "/tmp/example paperclip/.paperclip/config.json",
      instanceId: "paperclip-local",
    });

    expect(command).toContain("cd '/tmp/example paperclip'");
    expect(command).toContain("PAPERCLIP_CONFIG='/tmp/example paperclip/.paperclip/config.json'");
    expect(command).not.toContain("/Users/");
  });

  it("detects Paperclip LaunchAgents without requiring personal reverse-DNS names", () => {
    const summary = summarizeLaunchAgents([
      "io.paperclip.local.service.plist",
      "io.paperclip.local.healthcheck.plist",
      "io.paperclip.local.patch-refresh.plist",
      "io.paperclip.local.upstream-upgrade.plist",
    ]);

    expect(summary.launchAgents).toHaveLength(4);
    expect(summary.serviceLoaded).toBe(true);
    expect(summary.healthcheckLoaded).toBe(true);
    expect(summary.patchRefreshLoaded).toBe(true);
    expect(summary.upstreamUpgradeLoaded).toBe(true);
  });
});
