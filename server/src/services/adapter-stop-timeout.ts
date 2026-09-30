import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";

export interface AdapterStopContext {
  runId?: string;
  adapterType?: string;
  runtimeMode?: string;
  abortRequested?: boolean;
}

/** Diagnostic identity only. This error never acknowledges termination. */
export class AdapterStopTimeoutError extends Error {
  readonly diagnostics: Readonly<Record<string, string | number | boolean | null>>;

  constructor(timeoutMs: number, context?: AdapterStopContext) {
    super("Execution is still stopping; termination has not been verified.");
    // Keep the existing Error name and timer stack for default error grouping.
    Error.captureStackTrace?.(this, AdapterStopTimeoutError);
    this.diagnostics = Object.freeze({
      timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : null,
      runId: typeof context?.runId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context.runId)
        ? context.runId : null,
      adapterType: AGENT_ADAPTER_TYPES.some((type) => type === context?.adapterType) ? context!.adapterType! : "unknown",
      runtimeMode: context?.runtimeMode === "native" || context?.runtimeMode === "legacy" ? context.runtimeMode : "unknown",
      abortRequested: typeof context?.abortRequested === "boolean" ? context.abortRequested : null,
    });
  }
}
