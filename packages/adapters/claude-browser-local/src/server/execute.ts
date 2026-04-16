import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

/**
 * Week 1 skeleton. Day 2 wires this up to the Playwright sidecar.
 *
 * Responsibilities (final form):
 * 1. Ensure the sidecar is running (spawn + health-check unix socket).
 * 2. Translate prompt/context into BrowserTool calls via the Claude CLI.
 * 3. Forward each BrowserTool call to the sidecar over JSON-RPC.
 * 4. Stream logs back via ctx.onLog; upload artifacts via save_artifact.
 * 5. Return a clean AdapterExecutionResult with usage + sessionParams.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  await ctx.onLog(
    "stderr",
    "[claude_browser_local] skeleton execute() — sidecar wiring lands Day 2 (see /BUY/issues/BUY-2272#document-plan).\n",
  );
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "claude_browser_local skeleton — no-op Week 1 Day 1",
  };
}
