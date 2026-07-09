import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "acpx_local";
export const label = "ACPX (local)";

export const DEFAULT_ACPX_LOCAL_AGENT = "claude";
export const DEFAULT_ACPX_LOCAL_MODE = "persistent";
export const DEFAULT_ACPX_LOCAL_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACPX_LOCAL_TIMEOUT_SEC = 0;
export const DEFAULT_ACPX_LOCAL_WARM_HANDLE_IDLE_MS = 0;

export const acpxAgentOptions = [
  { id: "claude", label: "Claude via ACPX" },
  { id: "codex", label: "Codex via ACPX" },
  { id: "custom", label: "Custom ACP command" },
] as const;

export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# acpx_local agent configuration

Adapter: acpx_local

Use when:
- The agent should run through Agent Client Protocol via ACPX on the Paperclip host or a managed execution environment.
- You want one built-in adapter that can target Claude, Codex, or a custom ACP server command.
- You need Paperclip-managed session identity and live streamed ACP events in later ACPX runtime phases.

Don't use when:
- You need today's stable Claude Code or Codex CLI wrapper behavior. Use claude_local or codex_local until acpx_local runtime execution is enabled.
- The host cannot satisfy ACPX's Node >=22.12.0 prerequisite.
- The agent runtime is not an ACP server and cannot be launched through ACPX.

Core fields:
- agent (string, optional): claude, codex, or custom. Defaults to claude.
- agentCommand (string, optional): custom ACP command when agent=custom, or an override for a built-in ACP agent command.
- mode (string, optional): persistent or oneshot. Defaults to persistent. Paperclip keeps session state persistent and may close the live process between runs.
- cwd (string, optional): default absolute working directory fallback for the agent process.
- permissionMode (string, optional): defaults to approve-all, meaning ACPX permission requests are auto-approved.
- nonInteractivePermissions (string, optional): fallback behavior when ACPX cannot ask interactively. Supported values are deny and fail.
- stateDir (string, optional): ACPX state directory. Defaults to a Paperclip-managed company/agent scoped location.
- instructionsFilePath (string, optional): absolute path to a markdown instructions file used by Paperclip prompt construction.
- promptTemplate (string, optional): run prompt template.
- bootstrapPromptTemplate (string, optional): first-run bootstrap prompt template.
- model (string, optional): requested ACP model. Claude and Codex ACP agents both receive this through ACP session config.
- effort/modelReasoningEffort (string, optional): requested thinking effort. Claude uses effort; Codex uses modelReasoningEffort/reasoning_effort.
- fastMode (boolean, optional): for ACPX Codex, request Codex fast mode through ACP session config.
- timeoutSec (number, optional): run timeout in seconds. Defaults to 0, meaning no adapter timeout.
- warmHandleIdleMs (number, optional): live ACPX process idle window after a successful persistent run. Defaults to 0, meaning Paperclip shuts the process down after each run while retaining ACPX session state.
- env (object, optional): KEY=VALUE environment variables or secret bindings.

Dependency decision:
- acpx_local declares direct dependencies on acpx, @agentclientprotocol/claude-agent-acp, and @zed-industries/codex-acp so the built-in adapter has deterministic package resolution instead of relying on globally installed ACP commands.
- ACPX currently requires Node >=22.12.0. Paperclip keeps the repo-wide Node >=20 engine and surfaces the stricter runtime prerequisite through acpx_local diagnostics.
`;
