import { inferBindModeFromHost, isLoopbackHost } from "../packages/shared/src/network-bind.ts";

export type DevRunnerUiExposure = "loopback" | "remote";

export interface DevRunnerFileServerConfig {
  bind?: string | null;
  host?: string | null;
}

export interface DevRunnerUiModeInput {
  explicitUiDevMiddleware?: string | null;
  managedRuntimeExposure: boolean;
  cliBindMode?: string | null;
  cliBindHost?: string | null;
  fileServer?: DevRunnerFileServerConfig | null;
}

export function resolveUiExposure(
  input: Pick<DevRunnerUiModeInput, "cliBindMode" | "cliBindHost" | "fileServer">,
): DevRunnerUiExposure {
  if (input.cliBindMode) {
    if (input.cliBindMode === "loopback") return "loopback";
    if (input.cliBindMode === "custom") {
      return isLoopbackHost(input.cliBindHost) ? "loopback" : "remote";
    }
    return "remote";
  }

  const fileBind = input.fileServer?.bind;
  if (fileBind) {
    return fileBind === "loopback" ? "loopback" : "remote";
  }

  const fileHost = input.fileServer?.host;
  if (fileHost) {
    return inferBindModeFromHost(fileHost) === "loopback" ? "loopback" : "remote";
  }

  return "loopback";
}

export function shouldServeBuiltUi(input: DevRunnerUiModeInput): boolean {
  if (input.explicitUiDevMiddleware != null) {
    return false;
  }
  if (input.managedRuntimeExposure) {
    return true;
  }
  return resolveUiExposure(input) === "remote";
}
