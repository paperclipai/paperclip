import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createKimchiAcpExecutor, resolveKimchiExecutionEngineForRun } from "./acp.js";

const executeKimchiAcp = createKimchiAcpExecutor();

/**
 * kimchi_local execute: ACP-only dispatch. The engine is resolved up front; a
 * resolved unavailableReason returns the adapter_engine_unavailable error
 * result exactly like kimi-local, so a missing kimchi binary or Node version
 * surfaces as a setup error instead of a CLI-lane fallback (there is no CLI
 * lane in v1).
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveKimchiExecutionEngineForRun(ctx);
  if (engineSelection.unavailableReason) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_engine_unavailable",
      errorMessage: engineSelection.unavailableReason,
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
    };
  }
  return executeKimchiAcp(ctx);
}
