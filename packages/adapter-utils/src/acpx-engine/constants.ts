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

// The bound on how long the host waits, after a latched terminal sandbox
// duplex-channel loss, for the agent to answer the `turn.cancel()` request.
// `cancel()` only asks the agent to end the turn; it does not end the turn by
// itself. An agent that stopped answering never honors it, so this deadline
// is the host-side bound that ends the run without the agent's help. It is
// much smaller than the whole-adapter execution timeout.
export const ACPX_DUPLEX_LOSS_CANCEL_DEADLINE_MS = 30_000;

// The per-call deadline Claude applies to MCP tool calls (`MCP_TOOL_TIMEOUT`)
// when Paperclip attaches runtime MCP servers. Claude's own default is far
// longer than a run, so a gateway call that never answers holds the turn until
// the 4h sandbox backstop ends the run. The gateway bounds each provider call
// at 60s and approval preparation at 2 minutes; this leaves wide headroom over
// both.
// On expiry Claude returns an MCP error to the model and the turn continues.
// A user-configured `MCP_TOOL_TIMEOUT` still wins.
export const ACPX_CLAUDE_MCP_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

// The bound on how long a pending Claude tool call may go without any ACP
// update before the host ends the turn. `MCP_TOOL_TIMEOUT` only bounds an MCP
// call that reached its server. A call that stalls before that point (for
// example, a permission round trip or a subagent tool call that never
// executes) otherwise holds the turn until the 4h sandbox backstop, while a
// live subagent's periodic heartbeats keep the turn looking active. Claude's
// own tool bounds (MCP and Bash) end every healthy call well before this. The
// resolved bound always stays at least `ACPX_STALLED_TOOL_MARGIN_MS` above an
// `MCP_TOOL_TIMEOUT` or `BASH_MAX_TIMEOUT_MS` set in the launch environment.
export const ACPX_STALLED_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
export const ACPX_STALLED_TOOL_MARGIN_MS = 15 * 60 * 1000;
export const ACPX_STALLED_TOOL_CHECK_INTERVAL_MS = 60_000;
export const ACPX_TOOL_STALLED_ERROR_CODE = "acpx_tool_stalled";

// The closed ACP `ToolKind` enum. Run diagnostics may report these labels for
// pending tool calls; tool titles, names, and inputs never leave the run.
// Any other reported kind is collapsed to "unknown".
export const ACP_TOOL_KINDS = [
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
] as const;

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
