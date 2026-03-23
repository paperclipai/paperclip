export const type = "copilot_cli";
export const label = "GitHub Copilot CLI";

export const models = [
  { id: "gpt-5.4", label: "GPT 5.4" },
  { id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
  { id: "gpt-5.2-codex", label: "GPT 5.2 Codex" },
  { id: "gpt-5.2", label: "GPT 5.2" },
  { id: "gpt-5.1-codex-max", label: "GPT 5.1 Codex Max" },
  { id: "gpt-5.1-codex", label: "GPT 5.1 Codex" },
  { id: "gpt-5.1", label: "GPT 5.1" },
  { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { id: "gpt-5.1-codex-mini", label: "GPT 5.1 Codex Mini" },
  { id: "gpt-5-mini", label: "GPT 5 Mini" },
  { id: "gpt-4.1", label: "GPT 4.1" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
];

export const agentConfigurationDoc = `# copilot_cli agent configuration

Adapter: copilot_cli

Use when:
- The agent needs to run GitHub Copilot CLI locally on the host machine
- You need session persistence across runs (Copilot supports --resume for thread resumption)
- The task benefits from Copilot's built-in GitHub MCP server integration (issues, PRs, code search)
- You want multi-model flexibility (GPT, Claude, Gemini models available through one adapter)
- The agent needs autonomous multi-turn execution via --autopilot mode

Don't use when:
- You need a simple one-shot script execution (use the "process" adapter instead)
- The agent doesn't need conversational context between runs (process adapter is simpler)
- Copilot CLI is not installed on the host (install via: gh extension install github/gh-copilot)
- You need direct Anthropic API access with Claude-specific features like artifacts (use claude_local instead)

Core fields:
- cwd (string, optional): default absolute working directory for the agent process (created if missing)
- model (string, optional): model id (e.g. claude-sonnet-4.6, gpt-5.4)
- reasoningEffort (string, optional): reasoning effort level (low|medium|high); also accepts "effort" as a legacy alias
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): one-time prompt prepended on fresh sessions (when no session to resume); supports the same template variables as promptTemplate
- maxAutopilotContinues (number, optional): max autonomous turns via --max-autopilot-continues
- allowAll (boolean, optional): pass --yolo/--allow-all to bypass all permissions (default: true for autonomous execution)
- noCustomInstructions (boolean, optional): pass --no-custom-instructions to skip workspace instructions
- skillsEnabled (boolean, optional): inject Paperclip skill instructions via COPILOT_CUSTOM_INSTRUCTIONS_DIRS (default: true); set false to disable
- command (string, optional): defaults to "copilot"
- instructionsFilePath (string, optional): absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior; injected into the system prompt at runtime
- extraArgs (string[], optional): additional CLI args
- allowTool (string[], optional): tool names to allow without prompting (--allow-tool); comma-separated in the UI
- denyTool (string[], optional): tool names to always deny (--deny-tool); comma-separated in the UI
- env (object, optional): KEY=VALUE environment variables
- mcpConfig (string, optional): JSON string for --additional-mcp-config
- agent (string, optional): agent name for --agent flag
- workspaceStrategy (object, optional): execution workspace strategy; supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Copilot CLI uses --output-format json for JSONL streaming output
- Prompt is delivered via -p <text> argument
- Session resume: when a saved session ID is not found, the adapter automatically retries without a session
- Auth via COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variables
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars
`;
