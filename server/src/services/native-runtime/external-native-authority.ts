import type { Db } from "@paperclipai/db";
import { parseNativeExecutionInput, type NativeSession, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { dotRunnerBroker } from "../dot-runner-broker.js";
import { museRunnerBroker } from "../muse-runner-broker.js";

/** Shared fresh-run authority for native tools and authenticated REST mutations. */
export async function assertExternalNativeRunAuthority(db: Db, execution: NativeExecutionInput, authorityDatabase: Db = db): Promise<void> {
  if (execution.schema === "paperclip.native-execution-input.v6") return dotRunnerBroker(db).assertRunAuthority(execution);
  if (execution.schema === "paperclip.native-execution-input.v8") return museRunnerBroker(db).assertRunAuthority(execution, authorityDatabase);
  throw new Error("external_native_execution_required");
}

/** Classifies an existing external checkpoint; does not authorize execution or
 * replace the target-owned restore and current broker-authority checks. These
 * drivers have a durable driver session and deliberately no upstream session. */
export function hasExternalNativeCheckpointIdentity(
  value: unknown, executionValue: unknown, expected: ReturnType<NativeSession["identity"]>,
): boolean {
  const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>) : {};
  let execution: NativeExecutionInput;
  try { execution = parseNativeExecutionInput(executionValue); } catch { return false; }
  if (execution.schema !== "paperclip.native-execution-input.v6" && execution.schema !== "paperclip.native-execution-input.v8") return false;
  const checkpoint = record(value), identity = record(checkpoint.identity);
  const driver = execution.provider.kind === "muse" ? "muse_external"
    : execution.provider.kind === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp";
  if (checkpoint.backendKind !== "runner" || checkpoint.driverKind !== driver
    || execution.session.driverKind !== driver || checkpoint.sessionId !== expected.sessionId
    || checkpoint.providerSessionId != null
    || checkpoint.providerRecoveryPolicy !== undefined && checkpoint.providerRecoveryPolicy !== "same_session_only") return false;
  for (const field of ["companyId", "agentId", "issueId", "runId", "sessionId"] as const) {
    if (!expected[field] || identity[field] !== expected[field]) return false;
  }
  for (const field of ["companyId", "agentId", "issueId", "runId"] as const) {
    if (execution.binding[field] !== expected[field]) return false;
  }
  return execution.provider.binding.companyId === expected.companyId && execution.provider.binding.agentId === expected.agentId
    && (execution.session.normalizedSessionId === null || execution.session.normalizedSessionId === expected.sessionId);
}
