export const type = "hermes_local";
export const label = "Hermes Agent (local)";

export const DEFAULT_HERMES_LOCAL_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * Static fallback model list. Hermes does not expose a non-interactive
 * "list models" command; the full registry lives in
 * ~/.hermes/models_dev_cache.json (~1.8MB, ~3000+ entries) and overwhelms
 * the UI dropdown if surfaced raw. We ship a curated short list here
 * covering the models Koenig actively uses; users can override via
 * `adapterConfig.model` (free-form string) or by setting
 * PAPERCLIP_HERMES_MODELS=provider/m1,provider/m2 in the env.
 */
export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_HERMES_LOCAL_MODEL, label: "Claude Sonnet 4.6" },
  { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7" },
  { id: "anthropic/claude-haiku-4.6", label: "Claude Haiku 4.6" },
  { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "openai/gpt-5.2", label: "GPT-5.2" },
];

export const agentConfigurationDoc = `# hermes_local agent configuration

Adapter: hermes_local

Use when:
- You want Paperclip to run the Hermes Agent CLI locally as the agent runtime
- You want Hermes' built-in skill registry, memory, and gateway features
- You want session resume across heartbeats via -r <session_id>

Don't use when:
- Hermes is not installed (~/.local/bin/hermes missing)
- You need OpenCode-style typed JSONL streaming events (use opencode_local)
- You want skill packs symlinked from Paperclip's skills/ tree (use opencode_local / claude_local)

Core fields:
- cwd (string, optional): default absolute working directory; created if missing
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): Hermes model id, e.g. "anthropic/claude-sonnet-4.6"
- provider (string, optional): override inference provider (e.g. "openrouter", "anthropic")
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "hermes"
- extraArgs (string[], optional): additional CLI args appended after the built-in flags
- env (object, optional): KEY=VALUE environment variables

Headless safety:
- ignoreRules (boolean, optional, default false): pass --ignore-rules (skip auto-injection of AGENTS.md/SOUL.md/.cursorrules/memory)
- ignoreUserConfig (boolean, optional, default false): pass --ignore-user-config (use built-in defaults; .env still loaded)
- acceptHooks (boolean, optional, default true): pass --accept-hooks (auto-approve unseen shell hooks; required for headless)
- yolo (boolean, optional, default true): pass --yolo (bypass dangerous-command approvals; required for headless)
- maxTurns (number, optional): pass --max-turns N
- toolsets (string, optional): comma-separated toolset names passed via -t
- skills (string, optional): comma-separated skill names passed via -s

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (default unlimited)
- graceSec (number, optional): SIGTERM grace period in seconds (default 20)

Notes:
- Runs are executed with: hermes chat -q <prompt> -Q [--source paperclip] [-m model] [...]
- Sessions are resumed with -r when stored session id is present.
- Cost + token usage are fetched post-run via \`hermes sessions export --session-id <id> -\`,
  which emits a JSONL record with input_tokens / output_tokens / cache_read_tokens /
  estimated_cost_usd / actual_cost_usd. If the export fails the run still succeeds
  but with no usage data attached.
- Hermes does not expose a non-interactive model list; configure \`model\` as a
  free-form provider/model string. Set PAPERCLIP_HERMES_MODELS in env to override
  the dropdown's static fallback list.
`;
