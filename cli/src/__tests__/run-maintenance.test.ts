import { afterEach, describe, expect, it } from "vitest";
import {
  applyMaintenanceEnvironmentOverrides,
  resolveRunPreparationPolicy,
} from "../commands/run.js";

const NAMES = [
  "PAPERCLIP_MAINTENANCE_MODE",
  "HOST",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "HEARTBEAT_SCHEDULER_ENABLED",
  "PAPERCLIP_DB_BACKUP_ENABLED",
] as const;
const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("applyMaintenanceEnvironmentOverrides", () => {
  it("overrides hostile file or shell values before the server import", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_BIND = "lan";
    process.env.PAPERCLIP_BIND_HOST = "10.0.0.5";
    process.env.HEARTBEAT_SCHEDULER_ENABLED = "true";
    process.env.PAPERCLIP_DB_BACKUP_ENABLED = "true";

    applyMaintenanceEnvironmentOverrides(true);

    expect(process.env.PAPERCLIP_MAINTENANCE_MODE).toBe("true");
    expect(process.env.HOST).toBe("127.0.0.1");
    expect(process.env.PAPERCLIP_BIND).toBe("loopback");
    expect(process.env.PAPERCLIP_BIND_HOST).toBeUndefined();
    expect(process.env.HEARTBEAT_SCHEDULER_ENABLED).toBe("false");
    expect(process.env.PAPERCLIP_DB_BACKUP_ENABLED).toBe("false");
  });

  it("does not alter the environment when maintenance mode is disabled", () => {
    process.env.HOST = "10.0.0.5";
    applyMaintenanceEnvironmentOverrides(false);
    expect(process.env.HOST).toBe("10.0.0.5");
  });
});

describe("resolveRunPreparationPolicy", () => {
  it("makes maintenance startup preparation non-mutating", () => {
    expect(resolveRunPreparationPolicy(true, true)).toEqual({
      createInstanceDirectories: false,
      allowOnboarding: false,
      doctorRepair: false,
      generateBootstrapInvite: false,
    });
  });

  it("preserves normal run preparation behavior", () => {
    expect(resolveRunPreparationPolicy(false, undefined)).toEqual({
      createInstanceDirectories: true,
      allowOnboarding: true,
      doctorRepair: true,
      generateBootstrapInvite: true,
    });
  });
});
