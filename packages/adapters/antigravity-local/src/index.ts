// Antigravity CLI adapter module definition and metadata for Paperclip

export const type = "antigravity_local";
export const label = "Antigravity CLI";

// Default model ID used when creating a new Antigravity agent
export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "gemini-3.8-flash-high";

// Supported reasoning effort options for Antigravity sessions
export const ANTIGRAVITY_EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

// Available models supported by the Antigravity CLI
export const models = [
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

// User-facing documentation for antigravity_local configuration in Paperclip
export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to execute agent tasks using the native Antigravity CLI (\`agy\`)
- You want conversation sessions resumed across heartbeats via Antigravity's native \`--conversation <id>\`
- You want unattended agent execution using Antigravity's native \`--dangerously-skip-permissions\`
- You want streaming structured JSON output via \`--output-format stream-json\`

Don't use when:
- You are targeting Google's Gemini CLI with ACP or Gemini-specific CLI flags (use \`gemini_local\`)
- You need webhook-style external invocation (use \`http\` or \`openclaw_gateway\`)
- \`agy\` is not installed on the machine running Paperclip

Core fields:
- command (string, optional): CLI binary to run; defaults to "agy"
- cwd (string, optional): working directory fallback for the agent process
- model (string, optional): Antigravity model ID (e.g. "gemini-3.8-flash-high")
- agent (string, optional): Agent name for the CLI session
- effort (string, optional): Reasoning effort for the session ("low", "medium", "high")
- sandbox (boolean, optional): run in sandbox with terminal restrictions (default: false)
- dangerouslySkipPermissions (boolean, optional): auto-approve tool permissions (default: true)
- printTimeout (string, optional): timeout duration for print mode wait (e.g. "5m0s")
- extraArgs (string[], optional): additional user-supplied CLI arguments
- env (object, optional): environment variables to inject into the process
- instructionsFilePath (string, optional): path to instructions markdown file prepended to prompt
- promptTemplate (string, optional): prompt template for runs

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
