/** Content-free provider diagnostics carried by the existing PRP diagnostic event. */
export const PROVIDER_PERFORMANCE_DIAGNOSTIC = "provider_performance_spans";
export const PROVIDER_PERFORMANCE_ENV = "PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS";
export const MAX_PROVIDER_PERFORMANCE_SPANS = 128;
export const PROVIDER_PERFORMANCE_PHASES = [
  "provider.context.environment", "provider.context.instructions", "provider.skills.discovery",
  "provider.tools.resolve", "provider.model.resolve", "provider.model.stream",
  "provider.workspace.snapshot.track", "provider.workspace.snapshot.patch", "provider.workspace.snapshot.diff",
  "provider.workspace.git.discover", "provider.workspace.git.default_branch",
  "provider.dependencies.install", "provider.plugins.initialize",
] as const;
export type ProviderPerformancePhase = typeof PROVIDER_PERFORMANCE_PHASES[number];
export interface ProviderPerformanceSpan {
  name: ProviderPerformancePhase;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "ok" | "failed";
}

const names = new Set<string>(PROVIDER_PERFORMANCE_PHASES);
const maxDurationMs = 24 * 60 * 60 * 1000;

/** Project fields rather than forwarding provider attributes or untrusted diagnostic data. */
export function parseProviderPerformanceSpans(payload: unknown, observedAtMs: number): ProviderPerformanceSpan[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const diagnostic = payload as Record<string, unknown>;
  if (diagnostic.code !== PROVIDER_PERFORMANCE_DIAGNOSTIC || !Array.isArray(diagnostic.spans)) return [];
  const counts = new Map<string, number>();
  return diagnostic.spans.slice(0, MAX_PROVIDER_PERFORMANCE_SPANS).flatMap((value): ProviderPerformanceSpan[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const { name, startedAtMs, endedAtMs } = row;
    if (typeof name !== "string" || !names.has(name) || typeof startedAtMs !== "number" || typeof endedAtMs !== "number"
      || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
      || startedAtMs < observedAtMs - maxDurationMs || endedAtMs > observedAtMs + 1000
      || endedAtMs < startedAtMs || endedAtMs - startedAtMs > maxDurationMs) return [];
    const count = counts.get(name) ?? 0;
    if (count >= 16) return [];
    counts.set(name, count + 1);
    return [{ name: name as ProviderPerformancePhase, startedAtMs, endedAtMs,
      outcome: row.outcome === "failed" ? "failed" : "ok" }];
  });
}
