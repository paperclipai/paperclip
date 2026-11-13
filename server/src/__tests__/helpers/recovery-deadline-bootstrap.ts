import type { AdapterExecutionResult } from "../../adapters/types.js";

export const controlledCompanyBootstrapMessage = "Controlled review bootstrap unavailable";
export const controlledCompanyBootstrapScript = `console.error(${JSON.stringify(controlledCompanyBootstrapMessage)});process.exit(75)`;

export function controlledCompanyBootstrapResult(config: Record<string, unknown>, result: AdapterExecutionResult): AdapterExecutionResult {
  const args = config.args;
  if (config.command !== process.execPath || !Array.isArray(args) || args.length !== 2 || args[0] !== "-e" ||
      args[1] !== controlledCompanyBootstrapScript || result.exitCode !== 75 || result.signal !== null || result.timedOut ||
      result.resultJson?.stdout !== "" || result.resultJson?.stderr !== controlledCompanyBootstrapMessage + "\n") return result;
  return { ...result, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
}
