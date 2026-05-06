import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "../types.js";
import { execute as executeHttpAdapter } from "../http/execute.js";
import { parseAgentZeroBridgeConfig } from "./config.js";

export async function executeAgentZeroBridge(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  let config;
  try {
    config = parseAgentZeroBridgeConfig(ctx.config);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "CONFIG_INVALID",
      errorMessage: error instanceof Error ? error.message : "Invalid Agent Zero bridge configuration",
      summary: error instanceof Error ? error.message : "Invalid Agent Zero bridge configuration",
      provider: "agent-zero-bridge",
      biller: "agent-zero-bridge",
    };
  }

  return executeHttpAdapter({
    ...ctx,
    config: {
      url: config.url,
      method: "POST",
      timeoutMs: config.timeoutMs,
      headers: config.headers,
    },
    onMeta: async (meta: AdapterInvocationMeta) => {
      await ctx.onMeta?.({
        ...meta,
        adapterType: "agent_zero_bridge",
        commandNotes: [
          ...(meta.commandNotes ?? []),
          "Bridge contract: POST /invoke is fire-and-forget; status updates happen asynchronously inside the bridge.",
          ...(config.healthUrl ? [`healthUrl=${config.healthUrl}`] : []),
        ],
      });
    },
  });
}
