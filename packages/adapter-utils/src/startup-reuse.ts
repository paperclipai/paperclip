import type { AdapterRuntimeEvent } from "./types.js";

/** Local run-log evidence; never a first-party Telemetry event. */
export const STARTUP_REUSE_EVENT = "run.startup.reuse";
export const STARTUP_REUSE_SCHEMA = "paperclip.startup-reuse.v1";
export const STARTUP_REUSE_LAYERS = [
  "environment", "workspace", "runner", "provider_process", "provider_session",
] as const;
export type StartupReuseLayer = (typeof STARTUP_REUSE_LAYERS)[number];
export type StartupReuseState = "reused" | "fresh" | "unknown" | "not_applicable";
export const STARTUP_REUSE_REASONS = [
  "verified_reuse", "created", "replacement", "not_found", "expired",
  "identity_mismatch", "resume_failed", "configuration_changed", "tools_changed",
  "workspace_changed", "cache_miss", "not_applicable", "evidence_missing",
] as const;
export type StartupReuseReason = (typeof STARTUP_REUSE_REASONS)[number];
export interface StartupReuseDecision {
  state: StartupReuseState;
  reason: StartupReuseReason;
}
export interface StartupReuseSummary {
  warmth: "cold" | "warm" | "partial_reuse" | "unknown";
  layers: Record<StartupReuseLayer, StartupReuseDecision>;
  /** Null means unobserved, including older runs. Zero requires launch coverage. */
  providerLaunchCount: number | null;
}

export async function emitStartupReuse(
  onEvent: ((event: AdapterRuntimeEvent) => Promise<void>) | undefined,
  layer: StartupReuseLayer,
  decision: StartupReuseDecision,
  providerLaunchCount?: number | null,
): Promise<void> {
  try {
    await onEvent?.({
      eventType: STARTUP_REUSE_EVENT, stream: "system", level: "info",
      message: `startup reuse: ${layer} (${decision.state})`,
      payload: { schema: STARTUP_REUSE_SCHEMA, layer, ...decision,
        ...(layer === "provider_process" ? { providerLaunchCount: providerLaunchCount ?? null } : {}) },
    });
  } catch {
    // Diagnostic evidence must not change execution or settlement.
  }
}

export function environmentStartupReuse(target: {
  kind: string; transport?: string;
  sandboxLeaseAcquisition?: { outcome: string; reason?: string } | null;
} | null | undefined): StartupReuseDecision {
  if (!target || target.kind === "local") return { state: "not_applicable", reason: "not_applicable" };
  const acquisition = target.sandboxLeaseAcquisition;
  if (target.transport !== "sandbox" || !acquisition) return { state: "unknown", reason: "evidence_missing" };
  if (acquisition.outcome === "resumed") return { state: "reused", reason: "verified_reuse" };
  if (acquisition.outcome === "created") return { state: "fresh", reason: "created" };
  if (acquisition.outcome === "replacement") return { state: "fresh", reason:
    STARTUP_REUSE_REASONS.includes(acquisition.reason as StartupReuseReason)
      ? acquisition.reason as StartupReuseReason : "replacement" };
  return { state: "unknown", reason: "evidence_missing" };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read closed receipts, preserving absent/legacy evidence. No session-ID inference.
 * A fresh decision dominates reuse within a run (including same-run retries).
 */
export function summarizeStartupReuse(events: readonly { eventType?: string; payload?: unknown }[]): StartupReuseSummary {
  const layers = Object.fromEntries(STARTUP_REUSE_LAYERS.map(layer =>
    [layer, { state: "unknown", reason: "evidence_missing" }])) as StartupReuseSummary["layers"];
  const observed = new Set<StartupReuseLayer>();
  let providerLaunchCount: number | null = null;
  for (const event of events) {
    const p = record(event.payload);
    // Existing native physical-launch receipt. A session bootstrap/resume span
    // alone says nothing about the lifetime of its Runner or provider process.
    if (event.eventType === "run.performance.span" && p.schema === "paperclip.run-performance-span.v1" &&
        p.span === "runner.process.launch" && p.outcome === "ok") {
      layers.runner = { state: "fresh", reason: "created" };
      observed.add("runner");
    }
    if (event.eventType !== STARTUP_REUSE_EVENT || p.schema !== STARTUP_REUSE_SCHEMA ||
        !STARTUP_REUSE_LAYERS.includes(p.layer as StartupReuseLayer)) continue;
    const layer = p.layer as StartupReuseLayer;
    if (typeof p.state !== "string" || !["reused", "fresh", "unknown", "not_applicable"].includes(p.state) ||
        !STARTUP_REUSE_REASONS.includes(p.reason as StartupReuseReason)) continue;
    const decision = { state: p.state, reason: p.reason } as StartupReuseDecision;
    if (!observed.has(layer) || layers[layer].state !== "fresh") layers[layer] = decision;
    observed.add(layer);
    if (layer === "provider_process") {
      // The receipt is a cumulative observation for this invocation, not a delta.
      const count = p.providerLaunchCount;
      providerLaunchCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? Math.max(providerLaunchCount ?? 0, count) : null;
    }
  }
  if (providerLaunchCount !== null && providerLaunchCount > 0 && layers.provider_process.state !== "fresh") {
    layers.provider_process = { state: "fresh", reason: "created" };
  }
  const applicable = Object.values(layers).filter(layer => layer.state !== "not_applicable");
  const reused = applicable.some(layer => layer.state === "reused");
  const allReused = applicable.length > 0 && applicable.every(layer => layer.state === "reused");
  const warmth = allReused && providerLaunchCount === 0 ? "warm"
    : reused ? "partial_reuse"
    : applicable.length > 0 && applicable.every(layer => layer.state === "fresh") ? "cold" : "unknown";
  return { warmth, layers, providerLaunchCount };
}
