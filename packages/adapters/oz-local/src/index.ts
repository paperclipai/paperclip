export const type = "oz_local";
export const label = "Oz (local)";

export const DEFAULT_OZ_MODEL = "auto";

export const models = [
  { id: "auto", label: "Auto" },
  { id: "auto-efficient", label: "Auto (efficient)" },
  { id: "auto-genius", label: "Auto (genius)" },
  { id: "claude-4-6-sonnet-max", label: "Claude Sonnet 4.6 (max)" },
  { id: "claude-4-6-opus-max", label: "Claude Opus 4.6 (max)" },
  { id: "claude-4-5-sonnet", label: "Claude Sonnet 4.5" },
  { id: "claude-4-5-haiku", label: "Claude Haiku 4.5" },
  { id: "gemini-3-pro", label: "Gemini 3 Pro" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-4-high", label: "GPT-5.4 (high)" },
];

export const agentConfigurationDoc = `# oz_local agent configuration

Adapter: oz_local

Use when:
- You want Paperclip to run an Oz agent locally on the host machine using the \`oz\` CLI
- The task requires Warp's multi-model pool (Claude, GPT, Gemini, and others) without managing separate API keys
- You want conversation context resumed across runs via \`--conversation\`
- The agent needs MCP server access via \`--mcp\`
- You want Oz skill routing via \`--skill\`

Don't use when:
- You need cloud-hosted execution (oz_local only runs locally)
- The \`oz\` CLI is not installed (bundled with the Warp desktop app)
|- You need a simple one-shot script without an AI loop (use the process adapter instead)

Core fields:
- cwd (string, optional): absolute working directory for the agent process (created if missing)
- model (string, optional): model id, e.g. "auto", "claude-4-6-sonnet-max", "gpt-5". Defaults to "auto".
- promptTemplate (string, optional): run prompt template with {{agent.id}}, {{run.id}}, {{context.taskId}} etc.
- profile (string, optional): agent profile id from \`oz agent profile list\` — controls permissions and autonomy
- mcp (string, optional): MCP server specification — a UUID, inline JSON, or path to a JSON file
- skill (string, optional): skill spec to use as base prompt, e.g. "repo:skill_name" or "org/repo:skill_name"
- command (string, optional): defaults to "oz"
- extraArgs (string[], optional): additional CLI args appended to the command
- env (object, optional): KEY=VALUE environment variables injected into the process

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds

Auth:
- Set WARP_API_KEY in env or the adapter config env field to authenticate without interactive login
- Falls back to the current \`oz login\` session if WARP_API_KEY is not set

Notes:
- Runs with \`--output-format json\` (NDJSON); transcript shows structured tool calls, reasoning, and agent responses
- Session continuity uses Oz's \`--conversation <id>\` flag; the conversation ID is stored in session params
- \`pcurl\` and \`json2toon\` (from scripts/context-mode/) are injected into PATH so the agent can call the Paperclip API without triggering the curl denylist
- Skills are injected into ~/.warp/skills/ via symlinks so Oz can discover them naturally
- Set \`debug: true\` in config to enable \`--debug\` flag for verbose Oz diagnostic output
`;
