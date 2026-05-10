import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @github/copilot";

export const DEFAULT_COPILOT_LOCAL_MODEL = "gpt-5.3-codex";
export const DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS = [
  "shell(git:*)",
  "shell(pnpm:*)",
  "shell(npm:*)",
  "shell(node:*)",
  "shell(rg:*)",
  "shell(ls:*)",
  "shell(sed:*)",
  "shell(cat:*)",
  "read",
  "write",
] as const;

export const models = [
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "gpt-5.2", label: "gpt-5.2" },
  { id: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
  { id: "auto", label: "Auto" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Copilot CLI auto model routing without changing the primary model.",
    adapterConfig: {
      model: "auto",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt at runtime
- model (string, optional): Copilot CLI model id
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- allowTools (string[], optional): Copilot --allow-tool allowlist. Defaults to a narrow shell/read/write allowlist, never --allow-all.
- allowUrls (string[], optional): Copilot --allow-url allowlist
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Paperclip invokes Copilot CLI in programmatic prompt mode with -p, --output-format=json, and --no-ask-user.
- Paperclip does not default to --allow-all, --allow-all-tools, --allow-all-paths, --allow-all-urls, or --yolo.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
