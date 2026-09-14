import type { Sandbox } from "@daytonaio/sdk";
import { runtimeServiceProcessHandoffSource, type PluginEnvironmentProcessHandoffParams, type PluginEnvironmentProcessHandoffResult } from "@paperclipai/plugin-sdk";
import { assertDaytonaServiceDataAvailable } from "./service-data-deletion.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ticks = /^[1-9][0-9]{0,19}$/;
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 1;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
function receiptMatches(value: unknown, scope: Record<string, string>): value is Record<string, unknown> {
  if (!exact(value, ["version", "scope", "boot", "groupId", "leaderIdentity", "members"]) || value.version !== 1
    || !exact(value.scope, Object.keys(scope)) || Object.entries(scope).some(([key, expected]) => (value.scope as Record<string, unknown>)[key] !== expected)
    || !exact(value.boot, ["bootId", "initStartTicks", "uid"]) || typeof value.boot.bootId !== "string" || !uuid.test(value.boot.bootId)
    || typeof value.boot.initStartTicks !== "string" || !ticks.test(value.boot.initStartTicks) || !Number.isSafeInteger(value.boot.uid) || (value.boot.uid as number) < 0
    || !pid(value.groupId) || typeof value.leaderIdentity !== "string" || !ticks.test(value.leaderIdentity)
    || !Array.isArray(value.members) || !value.members.length || value.members.length > 512) return false;
  const members = value.members;
  return members.every((member) => exact(member, ["pid", "identity"]) && pid(member.pid) && typeof member.identity === "string" && ticks.test(member.identity))
    && new Set(members.map((member) => member.pid)).size === members.length
    && members.some((member) => member.pid === value.groupId && member.identity === value.leaderIdentity);
}

/** Never allocates, wakes compute, changes retention or stops the whole sandbox. */
export async function handleDaytonaProcessHandoff(sandbox: Sandbox, input: PluginEnvironmentProcessHandoffParams): Promise<PluginEnvironmentProcessHandoffResult> {
  const scope = { companyId: input.companyId, environmentId: input.environmentId, providerLeaseId: input.providerLeaseId };
  const errorCode = input.operation.action === "stop" ? "PROCESS_HANDOFF_UNVERIFIED" : "PROCESS_OWNERSHIP_UNVERIFIED";
  const failed = (): PluginEnvironmentProcessHandoffResult => ({ state: "failed", errorCode });
  if (!Object.values(scope).every((value) => typeof value === "string" && uuid.test(value))) return failed();
  if (input.operation.action === "stop" && !receiptMatches(input.operation.receipt, scope)) return failed();
  await sandbox.refreshData();
  if (sandbox.id !== input.providerLeaseId || sandbox.labels?.["paperclip-company-id"] !== input.companyId
    || sandbox.labels?.["paperclip-environment-id"] !== input.environmentId) return failed();
  assertDaytonaServiceDataAvailable(sandbox);
  if (sandbox.state !== "started") {
    if (input.operation.action === "stop" && (sandbox.state === "stopped" || sandbox.state === "archived")) return { state: "stopped" };
    return { state: "failed", errorCode: "PROCESS_HANDOFF_UNAVAILABLE" };
  }
  const encoded = JSON.stringify({ ...input.operation, scope });
  if (encoded.length > 128 * 1024) return failed();
  const result = await sandbox.process.executeCommand(`node -e ${quote(runtimeServiceProcessHandoffSource)}`, "/tmp", { PAPERCLIP_PROCESS_HANDOFF: encoded }, 15);
  // Provider output and thrown messages can contain arbitrary command output.
  // Only the bounded protocol below may enter the durable host receipt.
  if (typeof result.result !== "string" || result.result.length > 128 * 1024) return failed();
  let response: unknown;
  try { response = JSON.parse(result.result); } catch { return failed(); }
  if (result.exitCode === 0 && input.operation.action === "capture" && exact(response, ["state", "key", "receipt"])
    && response.state === "captured" && typeof response.key === "string" && /^[a-f0-9]{64}$/.test(response.key)
    && receiptMatches(response.receipt, scope)) return { state: "captured", key: response.key, receipt: response.receipt };
  if (result.exitCode === 0 && input.operation.action === "stop" && exact(response, ["state"]) && response.state === "stopped") return { state: "stopped" };
  if (exact(response, ["state", "errorCode"]) && response.state === "failed" && response.errorCode === "PROCESS_HANDOFF_UNAVAILABLE") {
    return { state: "failed", errorCode: "PROCESS_HANDOFF_UNAVAILABLE" };
  }
  return failed();
}
