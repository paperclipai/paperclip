export const type = "pi_local";
export const label = "Pi Agent (local)";

export const models = [
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex (OpenAI)" },
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Anthropic)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (Google)" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "sonnet", label: "Sonnet (pattern)" },
  { id: "haiku", label: "Haiku (pattern)" },
];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): model id/pattern passed via --model
- thinking (string, optional): thinking level override passed via --thinking (off|minimal|low|medium|high|xhigh)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "pi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use non-interactive JSON mode: pi --mode json --print.
- Session continuity is preserved through a stable --session file saved in adapter session params.
- Paperclip skills are passed via --skill when a skills directory is available.
- PAPERCLIP_* runtime env vars are injected automatically.
`;
