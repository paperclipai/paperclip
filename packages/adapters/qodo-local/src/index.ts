export const type = "qodo_local";
export const label = "Qodo CLI (local)";

export const models = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4-6-200k", label: "Claude Opus 4.6 (200K)" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Anthropic)" },
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (Anthropic)" },
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic)" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.2-high", label: "GPT-5.2 High" },
  { id: "gpt-5.2-max", label: "GPT-5.2 Max" },
  { id: "gpt-5.2-ultra", label: "GPT-5.2 Ultra" },
  { id: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  { id: "gpt-5-nano", label: "GPT-5 Nano" },
  { id: "gpt-5-mini", label: "GPT-5 Mini" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "grok-4", label: "Grok 4" },
  { id: "grok-code-fast-1", label: "Grok Code Fast 1" },
];

export const agentConfigurationDoc = `# qodo_local agent configuration

Adapter: qodo_local

Use when:
- The agent needs to run Qodo CLI locally on the host machine
- You need session persistence across runs (Qodo supports --resume)
- You want CI-friendly non-interactive execution (--ci --yes)
- The task benefits from Qodo's built-in tools (git, filesystem, shell, ripgrep, web search)

Don't use when:
- Qodo CLI is not installed (install via: npm install -g @qodo/command)
- You need a simple one-shot script execution (use the "process" adapter instead)

Core fields:
- cwd (string, optional): absolute working directory for the agent process
- model (string, optional): model name — discovered dynamically via \`qodo models\`. Run \`qodo models\` for the current list.
- promptTemplate (string, optional): run prompt template
- autoApprove (boolean, optional): pass --yes to confirm all prompts automatically (default: true)
- actMode (boolean, optional): pass --act to let the agent execute actions immediately (default: true)
- command (string, optional): defaults to "qodo"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
