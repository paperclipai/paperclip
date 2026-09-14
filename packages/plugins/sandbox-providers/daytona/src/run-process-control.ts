import type { Sandbox } from "@daytonaio/sdk";
import { isRemoteProcessIdentity, parseRemoteProcessControlResponse, remoteProcessControlSource,
  type PluginEnvironmentRunProcessControlParams, type PluginEnvironmentRunProcessControlResult } from "@paperclipai/plugin-sdk";
import { assertDaytonaServiceDataAvailable } from "./service-data-deletion.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Fresh physical ownership, no compute start/resume, and no mutable identity file. */
export async function handleDaytonaRunProcessControl(sandbox: Sandbox, input: PluginEnvironmentRunProcessControlParams): Promise<PluginEnvironmentRunProcessControlResult> {
  if (![input.companyId, input.environmentId, input.providerLeaseId].every(value => typeof value === "string" && uuid.test(value))
    || input.driverKey !== "daytona" || !isRemoteProcessIdentity(input.owner)) return { state: "unverified" };
  const operation = input.operation;
  if (!operation || typeof operation !== "object"
    || (operation.action === "signal" ? Object.keys(operation).sort().join(",") !== "action,signal" || !["SIGINT", "SIGTERM", "SIGKILL"].includes(operation.signal)
      : !["inspect", "stop_group"].includes(operation.action) || Object.keys(operation).join(",") !== "action")) return { state: "unverified" };
  await sandbox.refreshData();
  if (sandbox.id !== input.providerLeaseId || sandbox.labels?.["paperclip-company-id"] !== input.companyId
    || sandbox.labels?.["paperclip-environment-id"] !== input.environmentId) return { state: "unverified" };
  assertDaytonaServiceDataAvailable(sandbox);
  if (sandbox.state === "stopped" || sandbox.state === "archived") {
    return { state: operation.action === "stop_group" ? "stopped" : "exited" };
  }
  if (sandbox.state !== "started") return { state: "unverified" };
  const result = await sandbox.process.executeCommand(`node -e ${quote(remoteProcessControlSource)}`, "/tmp", {
    PAPERCLIP_REMOTE_PROCESS_CONTROL: JSON.stringify({ owner: input.owner, operation }), NODE_OPTIONS: "", NODE_PATH: "",
  }, 12);
  if (result.exitCode !== 0 || typeof result.result !== "string") return { state: "unverified" };
  return { state: parseRemoteProcessControlResponse(result.result, operation) };
}
