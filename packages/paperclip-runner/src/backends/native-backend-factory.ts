import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import {
  createCodexNativeSessionBackend,
  createRunnerdNativeSessionBackend,
  type CodexNativeSessionBackendOptions,
} from "./codex-native-backend.js";
import {
  createAcpxNativeSessionBackend,
  type CodexAcpxNativeSessionBackendOptions,
} from "./codex-acpx-native-backend.js";
import { createOpenCodeNativeSessionBackend } from "./opencode-native-backend.js";

export interface NativeBackendFactoryOptions extends Omit<
  CodexNativeSessionBackendOptions,
  "transportFactory"
> {
  codexTransportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
  }) => CodexAppServerTransport;
  acpxRuntimeDirectory?: string;
  acpxEnvironment?: NodeJS.ProcessEnv;
  acpxManagedCodexCredentialSourcePath?: string;
  acpxDynamicToolHandler?: CodexAcpxNativeSessionBackendOptions["dynamicToolHandler"];
  opencodeRuntimeDirectory?: string;
  opencodeEnvironment?: NodeJS.ProcessEnv;
  opencodeCommand?: string;
}

/**
 * Selects only provider implementations included in this release slice.
 * Persisted contracts for future providers do not make those providers
 * executable before their independently reviewed runtime ships.
 */
export function createNativeSessionBackend(
  input: NativeExecutionInput,
  options: NativeBackendFactoryOptions = {},
): NativeSessionBackend {
  if (options.codexTransportFactory) {
    return createRunnerdNativeSessionBackend(input, {
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
      environment: options.environment,
      workingDirectoryAuthority: options.workingDirectoryAuthority,
      transportFactory: options.codexTransportFactory,
    });
  }
  if (input.provider.kind === "opencode") {
    if (!options.opencodeRuntimeDirectory?.trim()) {
      throw new Error(
        "OpenCode native backend requires an instance runtime directory",
      );
    }
    return createOpenCodeNativeSessionBackend(input, {
      runtimeDirectory: options.opencodeRuntimeDirectory,
      environment: options.opencodeEnvironment,
      command: options.opencodeCommand,
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
    });
  }
  if (input.provider.kind === "acpx") {
    if (input.provider.agent === "pi") {
      throw new Error(
        "Native ACPX backend for pi is unavailable until descriptor-confined verified launch is implemented",
      );
    }
    if (!options.acpxRuntimeDirectory?.trim()) {
      throw new Error("ACPX backend requires an instance runtime directory");
    }
    return createAcpxNativeSessionBackend(input, {
      runtimeDirectory: options.acpxRuntimeDirectory,
      environment: options.acpxEnvironment,
      ...(input.provider.agent === "codex"
        ? {
            managedCodexCredentialSourcePath:
              options.acpxManagedCodexCredentialSourcePath,
          }
        : {}),
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.acpxDynamicToolHandler,
    });
  }
  if (input.provider.kind !== "codex") {
    throw new Error(
      `Native backend for ${input.provider.kind} is not included in the Codex-first runner`,
    );
  }

  return createCodexNativeSessionBackend(input, {
    runnerInstanceId: options.runnerInstanceId,
    onSpawn: options.onSpawn,
    dynamicTools: options.dynamicTools,
    dynamicToolHandler: options.dynamicToolHandler,
    environment: options.environment,
    workingDirectoryAuthority: options.workingDirectoryAuthority,
    transportFactory: options.codexTransportFactory,
  });
}
