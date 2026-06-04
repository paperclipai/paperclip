import type { ServerAdapterModule, AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { execute } from "./server/execute.js";
import { testEnvironment, listKimiSkills, syncKimiSkills, sessionCodec } from "./server/index.js";

export const type = "kimi_local";
export const label = "Kimi Code CLI (local)";

export const models = [
  { id: "kimi-k2-0711-preview", label: "Kimi K2" },
  { id: "kimi-k2-thinking-turbo", label: "Kimi K2 Thinking Turbo" },
  { id: "kimi-k2-5-turbo", label: "Kimi K2.5 Turbo" },
  { id: "kimi-k2-5-turbo-preview", label: "Kimi K2.5 Turbo Preview" },
  { id: "kimi-k2-5-long-context", label: "Kimi K2.5 Long Context" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to invoke Kimi Code CLI as a local agent.
- Kimi Code CLI is installed and configured on the host.
- You want to leverage Kimi's multi-provider support (Kimi, OpenAI, Anthropic, Gemini, Vertex AI).

Don't use when:
- Kimi Code CLI is not installed or not authenticated.
- You need a cloud-hosted agent rather than a local CLI process.

Core fields:
- agentPreset (select, required, default \`default\`): Which agent powers the Kimi runtime.
  - \`default\`: General-purpose built-in agent.
  - \`okabe\`: Experimental built-in agent with extra tools.
  - \`custom\`: Use a custom agent YAML file (set customAgentFile).
- customAgentFile (string, optional): Absolute path to a custom Kimi agent YAML file. Only used when agentPreset is \`custom\`.
- model (string, optional): Override the default LLM model (e.g. \`kimi-k2-0711-preview\`).
- thinking (boolean, optional): Enable thinking mode for supported models.
- noThinking (boolean, optional): Explicitly disable thinking mode.
- cwd (string, optional): Working directory for the agent process.
- command (string, optional): Kimi CLI command. Default: \`kimi\`.
- extraArgs (string, optional): Additional CLI arguments passed to Kimi.
- env (object, optional): Extra environment variables (e.g. \`KIMI_API_KEY\`).
- timeoutSec (number, optional): Run timeout in seconds. Default: 300.
- graceSec (number, optional): SIGTERM grace period in seconds. Default: 20.

Notes:
- Kimi Code CLI must be installed and authenticated (\`kimi /login\`) before use.
- Print mode is used internally, so all operations are auto-approved (--yolo is implicit).
- The stream-json output is parsed to extract the final assistant message.
`;

// ---------------------------------------------------------------------------
// Config schema — provides the UI selection field for "what powers the agent"
// ---------------------------------------------------------------------------

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "agentPreset",
        label: "Agent preset",
        type: "select",
        options: [
          { label: "Default (general purpose)", value: "default" },
          { label: "Okabe (experimental)", value: "okabe" },
          { label: "Custom agent file", value: "custom" },
        ],
        default: "default",
        required: true,
        hint: "Select which built-in agent or custom agent file powers this Kimi agent.",
      },
      {
        key: "customAgentFile",
        label: "Custom agent file path",
        type: "text",
        hint: "Absolute path to a custom Kimi agent YAML file. Only used when Agent preset is 'Custom agent file'.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        options: models.map((m) => ({ label: m.label, value: m.id })),
        hint: "Override the default model. Leave empty to use the model from ~/.kimi/config.toml.",
      },
      {
        key: "thinking",
        label: "Thinking mode",
        type: "toggle",
        default: false,
        hint: "Enable deeper reasoning before answering (requires model support).",
      },
      {
        key: "noThinking",
        label: "Disable thinking mode",
        type: "toggle",
        default: false,
        hint: "Explicitly disable thinking mode when the default model would otherwise use it.",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 300,
        hint: "Maximum run time in seconds before the process is terminated.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// External adapter entry point for Paperclip's plugin loader.
// Called by loadExternalAdapterPackage() via the adapter-plugin-store.
// ---------------------------------------------------------------------------

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listSkills: listKimiSkills,
    syncSkills: syncKimiSkills,
    sessionCodec,
    sessionManagement: getAdapterSessionManagement("kimi_local") ?? undefined,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: false,
    getConfigSchema,
  };
}

// Re-export server functions for direct import (builtin-style usage if needed)
export { execute, testEnvironment };
