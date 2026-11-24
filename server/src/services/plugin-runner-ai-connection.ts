import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { parseEnvironmentDriverConfig } from "./environment-config.js";

/**
 * A plugin environment that runs Runner tasks executes only runs with a
 * managed AI connection. The account installed on the provider's machine is
 * not a supported credential source, so Core refuses these runs and setup
 * probes before it leases or calls the provider.
 */
export const PLUGIN_RUNNER_AI_CONNECTION_REQUIRED = "ai_connection_required";

export const PLUGIN_RUNNER_AI_CONNECTION_REQUIRED_MESSAGE =
  "This agent's environment requires a managed AI connection. Choose an AI connection for this agent in Configuration, then retry.";

/** A preconfigured Runner home does not use the agent's AI connection, even when one is saved. */
export const PLUGIN_RUNNER_ISOLATED_HOME_REQUIRED_MESSAGE =
  "This agent's environment requires a managed AI connection, which a preconfigured Runner home does not use. Switch this agent to an isolated Runner home in Configuration, then retry.";

export function pluginRunnerAiConnectionRequiredMessage(preconfiguredHome: boolean) {
  return preconfiguredHome ? PLUGIN_RUNNER_ISOLATED_HOME_REQUIRED_MESSAGE : PLUGIN_RUNNER_AI_CONNECTION_REQUIRED_MESSAGE;
}

// The plugin's manifest declaration decides whether its environment runs
// Runner tasks. Run admission separately verifies a ready plugin and a live
// worker, so a plugin that is down still selects the Runner and fails its run.
/** The running plugin workers, for the methods each worker implements. */
export type PluginRunnerTaskWorkers = { getWorker(pluginId: string): { supportedMethods: readonly string[] } | undefined };

// With the running workers, a driver that lists its supported adapters returns
// only the adapters its worker supports end to end, the same list that sign-in
// and task submission use. A worker that is not running keeps the declared list:
// its runs fail at admission.
export async function pluginEnvironmentRunnerTaskDriver(db: Db, environment: Parameters<typeof parseEnvironmentDriverConfig>[0], workers?: PluginRunnerTaskWorkers) {
  let config: { pluginKey: string; driverKey: string };
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    if (parsed.driver !== "plugin") return undefined;
    config = parsed.config;
  } catch {
    return undefined;
  }
  const { pluginRegistryService } = await import("./plugin-registry.js");
  const plugin = await pluginRegistryService(db).getByKey(config.pluginKey);
  const driver = plugin?.manifestJson.capabilities.includes("environment.drivers.register")
    ? plugin.manifestJson.environmentDrivers?.find(driver => driver.driverKey === config.driverKey && driver.supportsTasks === true) : undefined;
  const methods = driver?.supportedAdapters && plugin ? workers?.getWorker(plugin.id)?.supportedMethods : undefined;
  if (!driver || !methods) return driver;
  const { pluginDriverSupportedAdapters } = await import("./plugin-environment-driver.js");
  return { ...driver, supportedAdapters: pluginDriverSupportedAdapters(driver, methods) };
}

/** The setup probe result for a plugin Runner-task target without a managed AI connection. */
export function pluginRunnerAiConnectionRequiredTestResult(adapterType: string, preconfiguredHome = false, testedAt = new Date().toISOString()): AdapterEnvironmentTestResult {
  return { adapterType, status: "fail", testedAt, checks: [{ code: PLUGIN_RUNNER_AI_CONNECTION_REQUIRED, level: "error",
    message: pluginRunnerAiConnectionRequiredMessage(preconfiguredHome) }] };
}

/** Lifecycle verification throws this before it resolves a probe target or acquires a lease. */
export function pluginRunnerAiConnectionRequiredFailure(preconfiguredHome: boolean) {
  return Object.assign(new Error(pluginRunnerAiConnectionRequiredMessage(preconfiguredHome)), { code: PLUGIN_RUNNER_AI_CONNECTION_REQUIRED });
}
