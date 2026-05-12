import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";

export const type = "qwen_local";
export const label = "Qwen Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @qwen-code/qwen-code";

export const models = [
  { id: "qwen3.6-plus", label: "Qwen 3.6 Plus" },
  { id: "qwen3.6-coder", label: "Qwen 3.6 Coder" },
  { id: "qwen3.5-coder", label: "Qwen 3.5 Coder" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Qwen 3.6 Coder for cost-effective tasks.",
    adapterConfig: {
      model: "qwen3.6-coder",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected via --system-prompt
- model (string, optional): Qwen model id (default: qwen3.6-plus)
- promptTemplate (string, optional): run prompt template
- maxSessionTurns (number, optional): max turns for one run (passed as --max-session-turns, default: 1)
- approvalMode (string, optional, default "yolo"): approval mode (plan|default|auto-edit|yolo)
- outputFormat (string, optional, default "stream-json"): output format (text|json|stream-json)
- command (string, optional): defaults to "qwen"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds (default 15)

Notes:
- Qwen Code CLI must be installed and authenticated before use.
- This adapter uses headless mode with positional prompt argument and --approval-mode yolo for non-interactive execution.
- Session resume is supported via -c (--continue) when the previous run produced a session_id.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement: {
      supportsSessionResume: true,
      nativeContextManagement: "unknown",
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 200,
        maxRawInputTokens: 2_000_000,
        maxSessionAgeHours: 72,
      },
    },
    models,
    modelProfiles,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
  };
}
