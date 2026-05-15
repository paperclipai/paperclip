import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "kimi_local";
export const label = "Kimi (Moonshot AI)";

export const DEFAULT_KIMI_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_KIMI_LOCAL_MODEL, label: "Auto" },
  { id: "kimi-k2.5", label: "Kimi K2.5" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
  { id: "kimi-for-coding", label: "Kimi For Coding" },
  { id: "kimi-k2", label: "Kimi K2" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Kimi K2 as the budget lane.",
    adapterConfig: {
      model: "kimi-k2",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run Kimi Code CLI locally as the agent runtime.
- You want Kimi (Moonshot AI) models to execute tools, edit files, and run shell commands.
- You want native bilingual (Chinese-English) agent capabilities.

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway).
- You only need one-shot shell commands (use process).
- Kimi Code CLI is not installed on the machine.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimi model id (for example kimi-k2.5). Defaults to auto.
- command (string, optional): defaults to "kimi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- This adapter uses Kimi's Wire protocol (JSON-RPC 2.0 over stdin/stdout).
- Runs are executed with: kimi --wire --yolo --work-dir <cwd> ...
- Sessions resume with --session when a stored sessionId is available.
- The adapter auto-approves all tool actions via --yolo for unattended Paperclip runs.
`;
