import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "hermes_local";
export const label = "Hermes (local)";

export const models: Array<{ id: string; label: string }> = [
  { id: "minimax/MiniMax-M2.7", label: "MiniMax M2.7" },
  { id: "minimax/MiniMax-M2", label: "MiniMax M2" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# hermes_local agent configuration

Adapter: hermes_local

Use when:
- You want Paperclip to run Hermes Agent locally as the agent runtime
- You want MiniMax (or other provider) as the underlying LLM
- You want Hermes tool-calling capabilities (terminal, file, web, search)

Don't use when:
- You need OpenClaw gateway features (use openclaw_gateway)
- Hermes is not installed on the machine

Core fields:
- command (string, optional): path to hermes binary (default: ~/.local/bin/hermes)
- model (string, optional): model id in provider/model format (default: minimax/MiniMax-M2.7)
- provider (string, optional): inference provider (default: minimax)
- toolsets (string, optional): comma-separated toolsets to enable (default: terminal,file,web,search,vision)
- cwd (string, optional): working directory for agent execution
- timeoutSec (number, optional): run timeout in seconds (default: 300)
- graceSec (number, optional): SIGTERM grace period on timeout (default: 20)

Notes:
- Hermes must be installed: \`pip install hermes-ai\` or \`brew install hermes-ai\`
- Default binary path: ~/.local/bin/hermes
- Session resume supported via --pass-session-id
- All tools (terminal, file, web, search, vision) are enabled by default
- The prompt from Paperclip is passed as a single query to \`hermes chat -q\`
`;
