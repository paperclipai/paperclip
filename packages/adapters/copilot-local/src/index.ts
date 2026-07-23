export const type = "copilot_local";
export const label = "GitHub Copilot";

export const SANDBOX_INSTALL_COMMAND =
  "npm_config_ignore_scripts=false npm install -g @github/copilot";

export const DEFAULT_COPILOT_LOCAL_MODEL = "gpt-5.6-sol";

export const models = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "GPT-5.6 Sol" },
  { id: "auto", label: "Auto" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- The agent should run GitHub Copilot CLI locally through its ACP server.
- GitHub Copilot subscription billing and enterprise policy should control model access.
- The runtime can authenticate with COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or a Copilot CLI login.

Don't use when:
- The account has no active GitHub Copilot entitlement or enterprise policy disables Copilot CLI.
- You need OpenAI API or ChatGPT subscription billing directly; use codex_local instead.
- You need a generic multi-provider harness; use opencode_local instead.

Core fields:
- cwd (string, optional): absolute working directory fallback for the Copilot process.
- instructionsFilePath (string, optional): absolute markdown instructions file prepended to every run prompt.
- model (string, optional): Copilot model id. Defaults to "${DEFAULT_COPILOT_LOCAL_MODEL}"; availability depends on account and enterprise policy.
- reasoningEffort (string, optional): none|minimal|low|medium|high|xhigh|max.
- promptTemplate (string, optional): run prompt template.
- command (string, optional): Copilot CLI executable, defaults to "copilot".
- extraArgs (string[], optional): additional Copilot ACP server arguments.
- env (object, optional): environment variables. Authentication precedence is COPILOT_GITHUB_TOKEN, GH_TOKEN, then GITHUB_TOKEN.

ACP fields:
- mode (string, optional): persistent or oneshot. Defaults to persistent.
- permissionMode (string, optional): approve-all, approve-reads, or deny-all.
- nonInteractivePermissions (string, optional): deny or fail.
- stateDir (string, optional): Paperclip ACP state directory override.
- warmHandleIdleMs (number, optional): warm ACP process idle timeout; defaults to 0.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): process termination grace period.

Notes:
- Paperclip disables Copilot CLI auto-update and remote session export for managed runs.
- GitHub authentication tokens are marked as secret environment variables so Copilot strips them from shell and MCP child environments. PAPERCLIP_API_KEY remains available to agent tools for control-plane access.
- Paperclip uses the configured COPILOT_HOME, the server's COPILOT_HOME, or the normal ~/.copilot home so existing Copilot CLI authentication remains available.
- GitHub Copilot model availability and premium-request accounting are controlled by the authenticated account and enterprise policy.
`;
