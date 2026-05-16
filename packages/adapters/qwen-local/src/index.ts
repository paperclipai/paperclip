import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  execute,
  sessionCodec,
  testEnvironment,
  listQwenSkills,
  syncQwenSkills,
} from "./server/index.js";

export const type = "qwen_local";
export const label = "Qwen Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @qwen-code/qwen-code";

export const models = [
  { id: "qwen3.6-plus", label: "Qwen 3.6 Plus (Coding Plan)" },
  { id: "qwen3.5-plus", label: "Qwen 3.5 Plus (Coding Plan)" },
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus (Coding Plan)" },
  { id: "qwen3-coder-next", label: "Qwen3 Coder Next (Coding Plan)" },
  { id: "qwen3-max-2026-01-23", label: "Qwen3 Max 2026-01-23 (Coding Plan)" },
  { id: "glm-5", label: "GLM-5 (Coding Plan)" },
  { id: "glm-4.7", label: "GLM-4.7 (Coding Plan)" },
  { id: "kimi-k2.5", label: "Kimi K2.5 (Coding Plan)" },
  { id: "MiniMax-M2.5", label: "MiniMax M2.5 (Coding Plan)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use qwen3-coder-plus for cost-effective coding tasks.",
    adapterConfig: {
      model: "qwen3-coder-plus",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): model id configured in Qwen Code settings (default: qwen3.6-plus)
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
- Qwen Code 0.15+ reads models/providers from ~/.qwen/settings.json and optional project .qwen/settings.json.
- The model selected here must match a modelProviders entry visible to the child qwen process.
- Coding Plan usually requires security.auth.selectedType=openai, baseUrl=https://coding.dashscope.aliyuncs.com/v1, and BAILIAN_CODING_PLAN_API_KEY available via settings.json env, process env, or adapter config env.
- This adapter uses headless mode with stdin prompt input and --approval-mode yolo for non-interactive execution.
- Paperclip runtime env, API usage hints, and selected runtime skills are prepended to the run prompt for heartbeat runs.
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
    listSkills: listQwenSkills,
    syncSkills: syncQwenSkills,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
  };
}
