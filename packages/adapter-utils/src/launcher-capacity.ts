/** v1 is opt-in: a launcher consumes this nonce and removes it before exec. */
export const LAUNCHER_NONCE_ENV = "PAPERCLIP_LAUNCHER_NONCE";
const PREFIX = "paperclip-launcher:";

export function hasLauncherCapacityRecord(stderr: string, nonce: string): boolean {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return false;
  // Count even malformed/embedded records; a valid sibling cannot redeem one.
  if (stderr.split(PREFIX).length !== 2) return false;
  return stderr.split(/\r?\n/).includes(`${PREFIX}v1:capacity_unavailable:${nonce}`);
}

/** Only adapter-validated bootstrap evidence can discount adapter setup logs. */
export function isLauncherCapacityFailure(run: {
  status: string;
  errorCode: string | null;
  exitCode: number | null;
  signal: string | null;
  resultJson: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
}): boolean {
  const result = run.resultJson;
  const recovery = result?.executionRecovery as Record<string, unknown> | undefined;
  const launcher = recovery?.launcher as Record<string, unknown> | undefined;
  const usage = run.usageJson ?? {};
  return run.status === "failed" && run.errorCode === "launcher_capacity_unavailable" &&
    run.exitCode === 5 && run.signal === null && result?.stdout === "" &&
    recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false &&
    launcher?.version === 1 && launcher.outcome === "capacity_unavailable" &&
    !result.errorFamily &&
    [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens,
      usage.input_tokens, usage.output_tokens, usage.cached_input_tokens,
      usage.rawInputTokens, usage.rawOutputTokens, usage.rawCachedInputTokens,
      usage.costUsd, usage.cacheAdjustedCostUsd]
      .every((value) => value == null || value === 0);
}
