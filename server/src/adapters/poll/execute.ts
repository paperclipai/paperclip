import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";

export async function execute(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Poll-only agent — execution is agent-initiated via API",
  };
}
