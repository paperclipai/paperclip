import { parseObject } from "../../adapters/utils.js";
import { parseNativeExecutionInput, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Provider placement is distinct from access to a task's workspace. */
export function heartbeatExternalProvider(input: {
  run: { runtimeMode: string | null; runnerProfileJson: unknown };
  agent: { adapterType: string; adapterConfig: unknown };
}): "openai_dot" | "grok_bot" | "muse" | null {
  const persisted = input.run.runtimeMode === "native"
    ? parseObject(input.run.runnerProfileJson).nativeExecutionInput : undefined;
  const provider = persisted !== undefined
    ? parseNativeExecutionInput(persisted).provider.kind
    : input.agent.adapterType === "paperclip_runner" ? parseObject(input.agent.adapterConfig).provider : null;
  return provider === "openai_dot" || provider === "grok_bot" || provider === "muse" ? provider : null;
}

export function nativeRuntimeHasInstructionFilesystem(backend: string): boolean {
  return !["claude_managed_agents_api", "aws_agentcore_harness_api", "openai_dot_mcp", "grok_bot_mcp", "muse_external"].includes(backend);
}

type TaskWorkspaceExecution = Exclude<NativeExecutionInput, {
  schema: "paperclip.native-execution-input.v6" | "paperclip.native-execution-input.v8";
}>;

export function nativeExecutionUsesTaskWorkspace(execution: NativeExecutionInput | null): execution is TaskWorkspaceExecution {
  return execution !== null && execution.schema !== "paperclip.native-execution-input.v6"
    && execution.schema !== "paperclip.native-execution-input.v8";
}
