import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { execute as claudeExecute, runClaudeLogin as runBaseClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import { verifyRufloConfig } from "./ruflo-env.js";

function wrapMeta(meta: AdapterInvocationMeta, commandNotes: string[]): AdapterInvocationMeta {
  return {
    ...meta,
    adapterType: "ruflo_claude_local",
    commandNotes: [...(meta.commandNotes ?? []), ...commandNotes],
  };
}

function missingRufloResult(detail: string): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "ruflo_required_missing",
    errorMessage: `Ruflo is required for this adapter. ${detail}`.trim(),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const verification = await verifyRufloConfig(ctx.config).catch((error) => ({
    ok: false as const,
    resolved: null,
    detail: error instanceof Error ? error.message : String(error),
  }));

  if (!verification.ok || !verification.resolved) {
    return missingRufloResult(verification.detail);
  }

  return claudeExecute({
    ...ctx,
    config: verification.resolved.config,
    onMeta: ctx.onMeta
      ? async (meta) => ctx.onMeta?.(wrapMeta(meta, verification.resolved.commandNotes))
      : undefined,
  });
}

export async function runRufloClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const verification = await verifyRufloConfig(input.config);
  if (!verification.ok) {
    throw new Error(`Ruflo is required for this adapter. ${verification.detail}`.trim());
  }
  return runBaseClaudeLogin({
    ...input,
    config: verification.resolved.config,
  });
}
