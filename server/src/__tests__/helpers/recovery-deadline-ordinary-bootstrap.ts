import { classifyCodexTerminalSessionFailure } from "@paperclipai/adapter-codex-local/server";
import type { AdapterExecutionResult } from "../../adapters/types.js";

export const controlledOrdinaryBootstrapFailure = {
  category: "service", title: "Selected model is at capacity", details: "Controlled bootstrap refusal before any domain action.",
} as const;
export const controlledOrdinaryBootstrapProtocol = JSON.stringify(controlledOrdinaryBootstrapFailure);
export const controlledOrdinaryBootstrapScript = `console.error(${JSON.stringify(controlledOrdinaryBootstrapProtocol)});process.exit(75)`;

export function controlledOrdinaryBootstrapResult(config: Record<string, unknown>, result: AdapterExecutionResult): AdapterExecutionResult {
  const args = config.args;
  if (config.command !== process.execPath || !Array.isArray(args) || args.length !== 2 || args[0] !== "-e" ||
      args[1] !== controlledOrdinaryBootstrapScript || result.exitCode !== 75 || result.signal !== null || result.timedOut ||
      result.resultJson?.stdout !== "" || result.resultJson?.stderr !== controlledOrdinaryBootstrapProtocol + "\n") return result;
  const failure = JSON.parse(result.resultJson.stderr) as typeof controlledOrdinaryBootstrapFailure;
  const classified = classifyCodexTerminalSessionFailure(failure, new Date());
  if (classified?.errorFamily !== "transient_upstream") return result;
  return { ...result, ...classified, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
}
