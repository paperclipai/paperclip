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
  /** Effective provider environment, including the assigned workspace boundary. */
  environment?: NodeJS.ProcessEnv;
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

function transportDriverIdentity(
  input: NativeExecutionInput,
): {
  kind:
    | "codex_app_server"
    | "opencode_server"
    | "claude_managed_agents_api"
    | "aws_agentcore_harness_api"
    | "acpx_runtime";
  displayName: string;
  version: string;
} {
  switch (input.provider.kind) {
    case "codex":
      return {
        kind: "codex_app_server",
        displayName: "Codex app-server",
        version: "codex-v2",
      };
    case "opencode":
      return {
        kind: "opencode_server",
        displayName: "OpenCode server",
        version: "1.18.17",
      };
    case "claude_managed":
      return {
        kind: "claude_managed_agents_api",
        displayName: "Claude Managed Agent",
        version: input.provider.managedProfile.betaVersion,
      };
    case "aws_agentcore":
      return {
        kind: "aws_agentcore_harness_api",
        displayName: "AWS AgentCore Harness",
        version: input.provider.agentCoreProfile.qualificationRevision,
      };
    case "acpx":
      if (input.provider.agent === "pi") {
        throw new Error(
          "Native ACPX backend for pi is unavailable until descriptor-confined verified launch is implemented",
        );
      }
      return {
        kind: "acpx_runtime",
        displayName: `${input.provider.agent === "claude" ? "Claude" : "Codex"} via ACPX`,
        version: "0.13.1",
      };
    default:
      throw new Error(
        "Native provider is not available through the local runnerd transport",
      );
  }
}

function createTransportBackedNativeSessionBackend(
  input: NativeExecutionInput,
  options: CodexNativeSessionBackendOptions,
): NativeSessionBackend {
  const driverIdentity = transportDriverIdentity(input);
  const isCodex = input.provider.kind === "codex";
  if (
    input.provider.kind === "codex"
    && input.provider.approvalPolicy !== undefined
    && input.provider.approvalPolicy !== "never"
  ) {
    throw new Error(
      "paperclip_runner_codex_permission_mode_unqualified: set codexPermissionMode to never before starting or recovering this native run",
    );
  }

  return new HarnessDriverBackend(new CodexAppServerDriver({
    ...(input.provider.model ? { model: input.provider.model } : {}),
    // Runnerd owns provider permissions for non-Codex facades. Their
    // Codex-compatible surface must never open a second approval channel.
    approvalPolicy:
      input.provider.kind === "codex"
        ? input.provider.approvalPolicy ?? "never"
        : "never",
    baseInstructions: nativeSystemInstructions(input),
    includeSkillInstructions: isCodex && "runtimeContext" in input,
    requestedCollaborationMode:
      isCodex && "executionMode" in input ? input.executionMode : "default",
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        ...(isCodex && "executionMode" in input && input.executionMode === "plan"
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
    environment: options.environment,
    driverIdentity,
    capabilities: isCodex
      ? {}
      : { steering: false, goals: false, threadLineage: false },
    collaborationModes: isCodex ? ["default", "plan"] : ["default"],
    requireProviderSessionIdentity: options.transportFactory !== undefined,
  }));
}

/**
 * Uses the Codex JSON-RPC facade strictly as the TypeScript transport shape.
 * Runnerd still selects and owns the real provider process from run.prepare.
 */
export function createRunnerdNativeSessionBackend(
  input: NativeExecutionInput,
  options: CodexNativeSessionBackendOptions,
): NativeSessionBackend {
  if (!options.transportFactory) {
    throw new Error("Runnerd native backend requires a transport factory");
  }
  return createTransportBackedNativeSessionBackend(input, options);
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
  return createTransportBackedNativeSessionBackend(input, options);
}
