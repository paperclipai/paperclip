export const type = "muse_code_local";
export const label = "Muse";

export const DEFAULT_MUSE_CODE_LOCAL_MODEL = "";

export const MUSE_CODE_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const models = [
  { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0" },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
];

export const agentConfigurationDoc = `# muse_code_local agent configuration

Adapter: muse_code_local

Use when:
- You want Paperclip to run Muse (the \`muse\` CLI) locally on the host machine
- You want Muse sessions resumed across heartbeats (the adapter persists the Muse session id and passes \`--session-id\` on the next wake)
- The host is already signed in to Muse (\`muse login\`) or provides \`META_API_KEY\`

Don't use when:
- You mean the personal Muse agent at muse.ai (that is the external \`muse\` invite flow, not this adapter)
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- The \`muse\` CLI is not installed on the machine that runs Paperclip
- You need SSH or sandbox environments: this adapter is local-only

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Muse model id passed as \`--model\`. Empty uses the model from the host Muse settings.
- effort (string, optional): reasoning effort passed as \`--reasoning-effort\`: none, minimal, low, medium, high, xhigh, max, or ultra. Empty uses the Muse default.
- dangerouslySkipPermissions (boolean, optional): when not false, pass \`--disable-approval\` so headless runs do not wait on tool approval prompts
- dangerouslyBypassSandbox (boolean, optional): when true, pass \`--disable-sandbox\` to disable Muse shell sandboxing
- command (string, optional): defaults to "muse"
- extraArgs (string[], optional): additional \`muse exec\` CLI args
- env (object, optional): KEY=VALUE environment variables. \`META_API_KEY\` takes priority over the host Muse account login.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 disables it)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`muse exec --json --prompt-file <tmp>\` for non-interactive execution. The prompt is written to a temporary file, never interpolated into a shell command, and stdout JSONL events are parsed for the session id, final text, and token usage.
- Runs always pass \`--disable-request-user-input\`, \`--disable-reminders\`, and \`--trust-workspace\` so heartbeats stay unattended and workspace skills/rules load.
- Sessions resume only when the stored session cwd matches the current execution cwd. A failed resume against a missing or workspace-mismatched session retries once with a fresh session.
- Paperclip auto-injects local skills into \`~/.agents/skills/\` via symlinks, which is Muse's user skills home, so the paperclip skill is discoverable without polluting the project checkout.
- Muse does not report a USD cost per run, so runs are accounted as unpriced token usage (provider "meta").
- Authentication uses \`META_API_KEY\` when set, otherwise the host \`muse login\` account session.
`;
