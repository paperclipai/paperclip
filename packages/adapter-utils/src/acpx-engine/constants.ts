export const DEFAULT_ACP_ENGINE_AGENT = "claude";
export const DEFAULT_ACP_ENGINE_MODE = "persistent";
export const DEFAULT_ACP_ENGINE_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACP_ENGINE_TIMEOUT_SEC = 0;
export const DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS = 0;

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
