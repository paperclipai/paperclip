/** Terminal provider diagnostics must dominate retry budgets and fallback modes.
 * Only structured refusal metadata or the exact observed adapter error qualifies;
 * task text, summaries and ordinary output are never scanned.
 */
export function isTerminalProviderRefusal(run: {
  errorCode?: string | null;
  error?: string | null;
  resultJson?: unknown;
} | null | undefined): boolean {
  if (!run) return false;
  const result = run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
    ? run.resultJson as Record<string, unknown> : {};
  if (run.errorCode === "model_refusal" || run.errorCode === "provider_safety_refusal"
      || result.errorFamily === "model_refusal" || result.stopReason === "refusal") return true;
  // Compatibility with the observed Codex adapter_failed diagnostic, before it
  // carries a structured error family. Do not turn generic safety prose into a gate.
  return run.errorCode === "adapter_failed" && typeof run.error === "string"
    && /^This content was flagged for possible cybersecurity risk\.?$/i.test(run.error.trim());
}
