import { adapterExecutionTargetIsRemote, readAdapterExecutionTarget } from "./execution-target.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";

/** Observe the final provider-stop fence, then await the adapter's cleanup.
 * Local files stay in place; remote copy-back needs its own settlement proof.
 * A stopped provider says nothing about arbitrary detached or external effects.
 */
export async function withLocalProviderSettlement(
  ctx: AdapterExecutionContext,
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
): Promise<AdapterExecutionResult> {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(target)) return execute(ctx);

  let providerStopped = false;
  const result = await execute({
    ...ctx,
    onProviderStopped: async () => {
      await ctx.onProviderStopped?.();
      providerStopped = true;
    },
  });
  if (!providerStopped || result.errorCode === "workspace_restore_failed") return result;
  return {
    ...result,
    executionSettlement: {
      providerStopped: true,
      workspaceSettled: true,
      actionOutcomes: "unknown",
    },
  };
}
