export const DEFAULT_ACP_ENGINE_AGENT = "claude";
export const DEFAULT_ACP_ENGINE_MODE = "persistent";
export const DEFAULT_ACP_ENGINE_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACP_ENGINE_TIMEOUT_SEC = 0;
export const DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS = 0;

// The bound on the ACP startup handshake (`runtime.ensureSession()`). This
// deadline is separate from, and much smaller than, the whole-adapter
// execution timeout: it bounds only the handshake, not the agent turn. A real
// handshake completes in a few seconds; this value gives it generous room
// before the host gives up and reports a closed timeout code.
export const ACPX_HANDSHAKE_TIMEOUT_MS = 60_000;

// How often the host polls the duplex control-channel disposition while the
// handshake is in flight. The read is a cheap, non-mutating getter, so a
// short interval costs nothing while giving the host near-immediate notice
// of a channel loss.
export const ACPX_HANDSHAKE_TRANSPORT_POLL_MS = 250;

export const ACPX_ADAPTER_AGENT_IDS = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  kimi_local: "kimi",
  custom_acp: "custom",
} as const;

export type AcpxAdapterType = keyof typeof ACPX_ADAPTER_AGENT_IDS;
export type AcpxAgentId = (typeof ACPX_ADAPTER_AGENT_IDS)[AcpxAdapterType];

export function acpxAgentIdForAdapterType(adapterType: string | null | undefined): AcpxAgentId | null {
  if (!adapterType) return null;
  return ACPX_ADAPTER_AGENT_IDS[adapterType as AcpxAdapterType] ?? null;
}
