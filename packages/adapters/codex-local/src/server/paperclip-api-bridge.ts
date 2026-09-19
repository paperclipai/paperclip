import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { startPaperclipApiPipeBridge } from "@paperclipai/adapter-utils/paperclip-api-pipe";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

/** Install a run-scoped control-plane transport without broadening network permissions. */
export async function withCodexPaperclipApiBridge(
  ctx: AdapterExecutionContext,
  execute: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
): Promise<AdapterExecutionResult> {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const env = parseObject(ctx.config.env);
  const apiUrl = asString(env.PAPERCLIP_API_URL, "");
  const apiToken = asString(env.PAPERCLIP_API_KEY, "");
  const bridgeDirectory =
    asString(env.PAPERCLIP_RUN_SCRATCH_DIR, "") ||
    asString(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "");
  // Remote execution already has the authenticated callback bridge. Native
  // runner dispatch is a separate surface and does not use this adapter hook.
  if (process.platform !== "linux" || target?.kind === "remote" || !apiUrl || !apiToken || !bridgeDirectory) {
    return execute(ctx);
  }
  let bridge;
  try {
    bridge = await startPaperclipApiPipeBridge({
      directory: bridgeDirectory,
      apiUrl,
      apiToken,
      runId: ctx.runId,
    });
  } catch {
    await ctx.onLog(
      "stderr",
      "[paperclip] Local Paperclip API pipe unavailable; direct control-plane curl calls may require approval.\n",
    );
    return execute(ctx);
  }
  try {
    await ctx.onLog(
      "stdout",
      "[paperclip] Run-authenticated local API pipe enabled; command network policy unchanged.\n",
    );
    return await execute({
      ...ctx,
      config: { ...ctx.config, env: { ...env, ...bridge.env } },
    });
  } finally {
    await bridge.stop().catch(async () => {
      await ctx.onLog("stderr", "[paperclip] Local Paperclip API bridge cleanup failed.\n");
    });
  }
}
