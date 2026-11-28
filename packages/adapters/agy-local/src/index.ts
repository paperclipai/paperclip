export const type = "agy_local";
export const label = "Antigravity CLI (agy)";
export const DEFAULT_AGY_LOCAL_MODEL = "gemini-3.8-flash-medium";

export const models = [
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (xhigh)" },
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (high)" },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (medium)" },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (high)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (via Antigravity)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking (via Antigravity)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (medium)" },
];

export const agentConfigurationDoc = `# agy_local agent configuration

Adapter: agy_local

Runs the locally installed Antigravity CLI (\`agy\`) in non-interactive print mode
(\`agy -p --output-format stream-json\`). Sessions resume by conversation id.

Use when:
- The machine already has \`agy\` installed and signed in (run \`agy\` once interactively to log in)
- You want Antigravity-hosted models (Gemini, Claude, GPT-OSS) as Paperclip agents
- You are on native Windows, where the packaged Antigravity runner has no build

Don't use when:
- \`agy\` is not installed on the host that runs the Paperclip server
- You need a managed sandbox or remote execution target

Core fields:
- cwd (string, optional): default absolute working directory for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- model (string, optional): model id from \`agy models\`. Default: ${DEFAULT_AGY_LOCAL_MODEL}
- effort (string, optional): low | medium | high | xhigh | max, passed as --effort
- mode (string, optional): accept-edits | auto | plan, passed as --mode. Unset keeps agy's unattended print-mode default
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions
- sandbox (boolean, optional): pass --sandbox
- promptTemplate (string, optional): run prompt template
- command (string, optional): agy binary path or name. Default: agy
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- timeoutSec (number, optional): run timeout in seconds, 0 for none
- graceSec (number, optional): SIGTERM grace period in seconds. Default: 20

Notes:
- Sessions are keyed by agy conversation id and only resumed when the saved cwd matches.
- Authentication is the host's existing agy login; Paperclip never stores agy credentials.
`;
