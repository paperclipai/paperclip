import {
  type AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type = "antigravity_local";
export const label = "Antigravity CLI (local)";

// agy is not published to npm; it must be installed via https://antigravity.dev
export const SANDBOX_INSTALL_COMMAND: null = null;

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL, label: "Auto" },
  // Gemini 3.5 family
  { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
  { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
  { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)" },
  // Gemini 3.1 family
  { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
  { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
  // Claude family
  { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
  // GPT / OSS
  { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini 3.5 Flash (Low) as the lower-cost Antigravity CLI lane.",
    adapterConfig: {
      model: "Gemini 3.5 Flash (Low)",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI (\`agy\`) locally on the host machine
- You want Antigravity CLI chat sessions resumed across heartbeats with --conversation / --continue
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Antigravity CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): model id. Defaults to auto.
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox)
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin (or stdin if command is invoked with --print -).
- Sessions resume with --conversation when stored session cwd matches the current cwd.
- Authentication uses local Antigravity CLI credentials in ~/.gemini/.
`;
