import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_NAMES = [
  "PAPERCLIP_MAINTENANCE_MODE",
  "HOST",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "HEARTBEAT_SCHEDULER_ENABLED",
  "PAPERCLIP_DB_BACKUP_ENABLED",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_AUTH_BASE_URL_MODE",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
  "PAPERCLIP_ENABLE_COMPANY_DELETION",
] as const;
const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("maintenance config safety", () => {
  it("forces loopback and disables autonomous/background facilities", async () => {
    process.env.PAPERCLIP_MAINTENANCE_MODE = "true";
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_BIND = "lan";
    process.env.PAPERCLIP_BIND_HOST = "10.0.0.5";
    process.env.HEARTBEAT_SCHEDULER_ENABLED = "true";
    process.env.PAPERCLIP_DB_BACKUP_ENABLED = "true";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "public";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://public.example.test";
    process.env.PAPERCLIP_ALLOWED_HOSTNAMES = "public.example.test";
    process.env.PAPERCLIP_ENABLE_COMPANY_DELETION = "true";

    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    expect(config).toMatchObject({
      maintenanceMode: true,
      host: "127.0.0.1",
      bind: "loopback",
      customBindHost: undefined,
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: [],
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
      companyDeletionEnabled: false,
      telemetryEnabled: false,
    });
  });
});
