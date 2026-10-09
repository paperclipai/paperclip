export const type = "agy_local";
export const label = "Antigravity CLI (local)";

// agy is not published to npm; it must be installed via https://antigravity.dev
export const SANDBOX_INSTALL_COMMAND: null = null;

export const DEFAULT_AGY_LOCAL_MODEL = "auto";
export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = DEFAULT_AGY_LOCAL_MODEL;

export const models = [
  { id: DEFAULT_AGY_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export const agentConfigurationDoc = `# agy_local agent configuration

Adapter: agy_local

Use when:
- You want Paperclip to run the Antigravity CLI (\`agy\`) locally on the host machine using its authenticated local account.
- You want Antigravity CLI chat sessions resumed across heartbeats with \`--conversation\`.
- You want to run canonical model IDs such as \`gemini-3.8-flash-high\`, \`gemini-3.8-flash-medium\`, or \`gemini-3.1-pro-high\` backed by local AGY authentication.
- You want Paperclip skills injected locally without polluting the workspace git repository.

Don't use when:
- You need Gemini API-key based access without the local AGY CLI installed (use \`gemini_local\` instead).
- You need webhook-style external invocation (use \`http\` or \`openclaw_gateway\`).
- You only need a one-shot script without an AI coding agent loop (use \`process\`).
- Antigravity CLI (\`agy\`) is not installed on the machine that runs Paperclip.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible).
- instructionsFilePath (string, optional): absolute path to a markdown instructions file (e.g. AGENTS.md) prepended to the run prompt.
- promptTemplate (string, optional): run prompt template.
- model (string, optional): canonical CLI model ID (e.g. \`gemini-3.8-flash-high\`, \`gemini-3.8-flash-medium\`, \`gemini-3.8-flash-low\`, \`gemini-3.7-flash-high\`, \`gemini-3.1-pro-high\`, \`claude-sonnet-4-6\`). Defaults to \`auto\` (lets \`agy\` use its default model). Custom model IDs are also supported.
- dangerouslySkipPermissions (boolean, optional): pass \`--dangerously-skip-permissions\` to auto-approve AGY tool actions. Defaults to false; enable only when unattended tool execution is intended.
- sandbox (boolean, optional): run in sandbox mode (default: true, passes \`--sandbox\`).
- command (string, optional): CLI command override, defaults to "agy".
- extraArgs (string[], optional): additional CLI args.
- env (object, optional): KEY=VALUE environment variables.

Every run prefixes its prompt with Antigravity's \`/goal\` slash command. Do not configure \`-goal\` or \`--goal\` in \`extraArgs\`; those are not CLI startup flags and are ignored.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- Runs send prompts over stdin using AGY's \`--input-format stream-json\` protocol and consume structured events via \`--output-format stream-json\`. This avoids command-line length limits for large prompts.
- Session policy: resume is supported; native context management is unconfirmed. Paperclip defaults to rotation after 200 runs, 2,000,000 raw input tokens, or 72 hours, with runtime overrides supported.
- Sessions resume with \`--conversation <id>\` when the stored session working directory matches the current working directory.
- Authentication uses the AGY CLI's existing local account session in \`~/.gemini/\`; complete sign-in through the authentication flow supported by the installed AGY version.
- Environment preflight checks verify executable availability and basic help output; they do not perform a live model generation or confirm account/model access.
`;
