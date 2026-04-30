import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const message =
    "acpx_local runtime execution is not implemented in this Phase 1 scaffold. Use claude_local or codex_local until the ACPX runtime phase lands.";
  await ctx.onLog("stderr", `${message}\n`);
  await ctx.onLog("stdout", `${JSON.stringify({ type: "acpx.error", message, phase: "scaffold" })}\n`);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    provider: "acpx",
    model: null,
    resultJson: {
      code: "acpx_runtime_not_implemented",
      phase: "scaffold",
    },
    summary: message,
  };
}
