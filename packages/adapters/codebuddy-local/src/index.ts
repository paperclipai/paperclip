import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";

export const type = "codebuddy_local";
export const label = "CodeBuddy Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @tencent-ai/codebuddy-code";

export const models = [
  // 火山引擎 (V-)
  { id: "V-glm-5.1", label: "GLM 5.1 (火山)" },
  { id: "V-kimi-k2.6", label: "Kimi K2.6 (火山)" },
  { id: "V-kimi-k2.5", label: "Kimi K2.5 (火山)" },
  { id: "V-minimax-m2.7", label: "MiniMax M2.7 (火山)" },
  { id: "V-doubao-seed-2-0-code-preview-260215", label: "Doubao Seed 2.0 Code (火山)" },
  // DeepSeek 官方 (D-)
  { id: "D-deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "D-deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  // 小米 MiMo (M-)
  { id: "M-mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
  { id: "M-mimo-v2-pro", label: "MiMo V2 Pro" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use V-glm-5.1 (Volcengine) as the cost-effective lane.",
    adapterConfig: {
      model: "V-glm-5.1",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# codebuddy_local agent configuration

Adapter: codebuddy_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected via --system-prompt-file
- model (string, optional): CodeBuddy model id (default: glm-5.1)
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run (passed as --max-turns)
- dangerouslySkipPermissions (boolean, optional, default true): pass -y to codebuddy
- command (string, optional): defaults to "codebuddy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds (default 15)

Notes:
- CodeBuddy CLI must be installed and authenticated before use.
- This adapter uses \`--print --output-format json\` for non-interactive execution.
- Session resume is supported via \`--resume <session_id>\` when the previous run produced a session_id.
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
