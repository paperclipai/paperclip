import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";

export const type = "ruflo_claude_local";
export const label = "Claude Code + Ruflo (local)";

export const models = claudeModels;

export const agentConfigurationDoc = `${claudeAgentConfigurationDoc}

Ruflo-specific fields:
- rufloRequired (boolean, optional): when true (default), Paperclip refuses to run unless Ruflo is installed and attached to Claude MCP
- rufloCommand (string, optional): optional direct Ruflo command to verify; when omitted, Paperclip relies on Claude MCP registration only
- rufloMcpServerName (string, optional): defaults to "ruflo"
- claudeConfigHome (string, optional): absolute home directory used for the Claude/Ruflo config environment

Notes:
- This adapter still runs Claude Code as the runtime. Ruflo is enforced as an attached Claude MCP/tooling layer.
- Use this for engineering workers that must always run inside a Ruflo-prepared Claude environment.
`;
