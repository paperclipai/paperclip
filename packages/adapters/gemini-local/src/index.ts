export const type = "gemini_local";
export const label = "Gemini CLI (local)";
export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  // --- Gemini 3.x family (latest, March 2026) ---
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro Preview (Custom Tools)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "gemini-3-pro", label: "Gemini 3 Pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  // --- Gemini 2.x family ---
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
  // --- Image generation models ---
  { id: "imagen-4.0-generate-preview", label: "Imagen 4.0 Generate (Preview)" },
  { id: "gemini-2.0-flash-preview-image-generation", label: "Gemini 2.0 Flash Image Generation" },
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
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY or local Gemini CLI login.
`;
