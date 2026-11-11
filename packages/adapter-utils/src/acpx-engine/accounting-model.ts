import type { AcpRuntimeStatus } from "acpx/runtime";

/** Use provider-selected IDs, including its default. A mid-turn model change
 * cannot be priced as a single-model receipt; never guess from a display name. */
export function acpxAccountingModel(requested: string, before: AcpRuntimeStatus | null, after: AcpRuntimeStatus | null): string | null {
  const pre = before?.models?.currentModelId?.trim();
  const post = after?.models?.currentModelId?.trim();
  if (pre && post && pre !== post) return null;
  return post || pre || requested.trim() || null;
}

/**
 * Resolve the model context-window token limit in effect for a turn, for
 * failure diagnostics (EYW-692). Prefers a runtime-reported value — an
 * agent that actually negotiated or knows its window — over the
 * operator-configured value the host explicitly set (e.g. a CODEX_CONFIG
 * model_context_window the ACPX engine injected at startup). Null when no
 * source is known; never guessed from a model name.
 */
export function acpxContextWindow(
  before: AcpRuntimeStatus | null,
  after: AcpRuntimeStatus | null,
  configuredWindow?: number,
): number | null {
  const fromDetails = (status: AcpRuntimeStatus | null): number | null =>
    asWindow(status?.details?.modelContextWindow);
  const post = fromDetails(after);
  if (post !== null) return post;
  const pre = fromDetails(before);
  if (pre !== null) return pre;
  return asWindow(configuredWindow);
}

function asWindow(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
