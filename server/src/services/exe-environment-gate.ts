import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

export function isExeEnvironment(environment: { driver: string; config?: unknown }): boolean {
  const config = environment.config as Record<string, unknown> | null;
  return (environment.driver === "sandbox" && config?.provider === "exe-dev") ||
    (environment.driver === "plugin" && config?.driverKey === "exe-dev");
}

/** Gate new work, never the teardown of an already acquired lease. */
export async function assertExeEnvironmentEnabled(db: Db, environment: { driver: string; config?: unknown }) {
  if (environment.driver === "plugin" && isExeEnvironment(environment)) {
    throw forbidden("Configure exe.dev using the sandbox environment driver.");
  }
  if (isExeEnvironment(environment) && !(await instanceSettingsService(db).getExperimental()).enableExeEnvironments) {
    throw forbidden("Enable experimental exe.dev environments in instance settings before using this environment.");
  }
}
