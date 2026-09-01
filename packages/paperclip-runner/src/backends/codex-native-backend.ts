import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import { nativeSystemInstructions, nativeTaskConstraints } from "./runtime-context.js";

export interface CodexNativeSessionBackendOptions {
  runnerInstanceId?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  transportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
  }) => CodexAppServerTransport;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: {
    tool: string;
    callId: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  }) => Promise<unknown>;
}

/**
 * Constructs the first production-native provider boundary. Other provider
 * contracts may already be persisted, but their runtime implementations are
 * deliberately shipped in separate provider slices.
 */
export function createCodexNativeSessionBackend(
  input: NativeExecutionInput,
  options: CodexNativeSessionBackendOptions = {},
): NativeSessionBackend {
  if (input.provider.kind !== "codex") {
    throw new Error("Codex native backend requires provider kind codex");
  }

  return new HarnessDriverBackend(new CodexAppServerDriver({
    ...(input.provider.model ? { model: input.provider.model } : {}),
    approvalPolicy: input.provider.approvalPolicy ?? "untrusted",
    baseInstructions: nativeSystemInstructions(input),
    includeSkillInstructions: "runtimeContext" in input,
    requestedCollaborationMode:
      "executionMode" in input ? input.executionMode : "default",
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        ...("executionMode" in input && input.executionMode === "plan"
          ? [
              "Use native plan collaboration mode and do not modify workspace files.",
              "Treat the supplied Paperclip planning context as the canonical pinned base revision.",
              "Complete one structured provider plan item; Paperclip will synchronize it after completion.",
              "Keep the final response to a short synchronization summary instead of repeating the full plan.",
            ]
          : []),
        ...nativeTaskConstraints(input),
        "Return one semantic completion result.",
      ],
    }),
    runnerInstanceId:
      options.runnerInstanceId ?? `paperclip-native-${input.binding.runId}`,
    onSpawn: options.onSpawn,
    transportFactory: options.transportFactory,
    dynamicTools: options.dynamicTools,
    dynamicToolHandler: options.dynamicToolHandler,
    driverIdentity: {
      kind: "codex_app_server",
      displayName: "Codex app-server",
      version: "codex-v2",
    },
    collaborationModes: ["default", "plan"],
    requireProviderSessionIdentity: options.transportFactory !== undefined,
  }));
}
