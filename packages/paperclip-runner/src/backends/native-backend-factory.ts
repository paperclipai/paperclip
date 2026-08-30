import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import {
  createCodexNativeSessionBackend,
  type CodexNativeSessionBackendOptions,
} from "./codex-native-backend.js";

export interface NativeBackendFactoryOptions
  extends Omit<CodexNativeSessionBackendOptions, "transportFactory"> {
  codexTransportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
  }) => CodexAppServerTransport;
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
    transportFactory: options.codexTransportFactory,
  });
}
