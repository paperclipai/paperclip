export const type = "bob_shell";
export const label = "Bob Shell (local)";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# bob_shell agent configuration

Adapter: bob_shell

Core fields:
- cwd (string, optional): default absolute working directory for the Bob Shell process (created if missing when possible)
- mode (string, optional): Bob Shell custom mode to use (defaults to "paperclip-agent")
- modeConfig (object, optional): custom mode configuration with fields:
  - whenToUse (string, optional): when to use this mode
  - groups (string[], optional): available tool groups (defaults to ["read", "edit", "command", "browser", "mcp"])
- command (string, optional): Bob Shell executable command (defaults to "bob")
- extraArgs (string[], optional): additional CLI arguments to pass to Bob Shell
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 for no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds before SIGKILL

Bob Shell Integration:
- Paperclip will generate .bob/ workspace configuration before launching Bob Shell
- Generated files include:
  - .bob/custom_modes.yaml (managed "paperclip-agent" mode)
  - .bob/mcp.json (managed "paperclip" MCP server entry)
  - .bob/rules-paperclip-agent/*.md (runtime instructions and company skills)
- Bob Shell connects back to Paperclip via the Paperclip MCP server
- Paperclip injects runtime context via environment variables:
  - PAPERCLIP_API_URL
  - PAPERCLIP_API_KEY
  - PAPERCLIP_COMPANY_ID
  - PAPERCLIP_AGENT_ID
  - PAPERCLIP_RUN_ID
  - PAPERCLIP_TASK_ID (when applicable)
  - PAPERCLIP_WORKSPACE_* (workspace context)

Notes:
- Bob Shell must be installed and available in PATH or via the configured command
- Paperclip-managed .bob/ files may be refreshed during workspace sync
- User changes to managed Paperclip entries may be overwritten
- Unrelated Bob Shell configuration (other modes, MCP servers) is preserved
`;
