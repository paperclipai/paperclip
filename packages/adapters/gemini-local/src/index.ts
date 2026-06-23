import {
  buildSandboxNpmInstallCommand,
  type AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type = "gemini_local";
export const label = "Gemini CLI (local)";

export const SANDBOX_INSTALL_COMMAND = buildSandboxNpmInstallCommand("@google/gemini-cli");

export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4.6-thinking", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4.6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (medium)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini 3.1 Pro (Low) as the budget lane while preserving the primary model.",
    adapterConfig: {
      model: "gemini-3.1-pro-low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Use when:
- You want Paperclip to run the Gemini CLI locally on the host machine
- You want Gemini chat sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Gemini CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Gemini model id. Defaults to auto.
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox=none)
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use --prompt for non-interactive execution, not stdin.
- The adapter sets a headless-safe terminal/browser environment for Gemini CLI child processes so unattended runs do not wait on browser auth or 256-color terminal prompts.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY or local Gemini CLI login.
`;
