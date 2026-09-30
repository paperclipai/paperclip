import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { NATIVE_EXECUTION_INPUT_SCHEMA } from "../contracts/native-execution.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import { OpenCodeServerDriver, type OpenCodeServerDriverOptions } from "../drivers/opencode/opencode-server-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import { nativeSystemInstructions, nativeTaskConstraints } from "./runtime-context.js";

export function createOpenCodeNativeSessionBackend(
  input: NativeExecutionInput,
  options: Omit<OpenCodeServerDriverOptions, "model" | "taskEnvelope">,
): NativeSessionBackend {
  if (input.provider.kind !== "opencode" || !input.provider.model) {
    throw new Error("OpenCode native backend requires a persisted OpenCode provider/model selection");
  }
  const preparedContext = input.schema === NATIVE_EXECUTION_INPUT_SCHEMA;
  const constraints = [
      ...nativeTaskConstraints(input),
      "Return one semantic completion result through paperclip_finish or paperclip_block.",
    ];

  return new HarnessDriverBackend(new OpenCodeServerDriver({
    ...options,
    systemInstructions: nativeSystemInstructions(input),
    runtimeContext: "runtimeContext" in input ? input.runtimeContext : null,
    model: input.provider.model,
    permissionMode: input.provider.permissionMode ?? "allow",
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints,
    }),
    conversationMode: preparedContext ? "prepared" : "task",
  }), preparedContext ? constraints : undefined);
}
