export const DEFAULT_ACP_ENGINE_AGENT = "claude";
export const DEFAULT_ACP_ENGINE_MODE = "persistent";
export const DEFAULT_ACP_ENGINE_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACP_ENGINE_TIMEOUT_SEC = 0;

/**
 * Resolve the fleet-wide default warm ACP process idle timeout (ms).
 *
 * Warm-persistent handles keep the ACP child process alive for this many ms
 * after a successful turn so the very next heartbeat re-uses a hot process
 * (the "always-warm background agent" behaviour). Per-agent adapter config
 * (`warmHandleIdleMs`) still takes precedence over this default.
 *
 * Shipped default is `0` (feature off) to avoid changing the fleet-wide
 * process footprint without an explicit opt-in. Operators flip the whole
 * fleet warm by exporting `ACPX_ENGINE_WARM_HANDLE_IDLE_MS` (e.g. `120000`)
 * — no per-agent config edit required. Non-numeric / negative values fall
 * back to `0`.
 */
export function resolveDefaultAcpEngineWarmHandleIdleMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ACPX_ENGINE_WARM_HANDLE_IDLE_MS;
  if (raw === undefined || raw === null || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export const DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS = resolveDefaultAcpEngineWarmHandleIdleMs();

export const ACPX_ADAPTER_AGENT_IDS = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  custom_acp: "custom",
} as const;

export type AcpxAdapterType = keyof typeof ACPX_ADAPTER_AGENT_IDS;
export type AcpxAgentId = (typeof ACPX_ADAPTER_AGENT_IDS)[AcpxAdapterType];

export function acpxAgentIdForAdapterType(adapterType: string | null | undefined): AcpxAgentId | null {
  if (!adapterType) return null;
  return ACPX_ADAPTER_AGENT_IDS[adapterType as AcpxAdapterType] ?? null;
}
