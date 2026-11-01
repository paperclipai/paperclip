export { sessionCodec } from "./session.js";
export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  createMuseAcpExecutor,
  resolveMuseExecutionEngine,
  resolveMuseExecutionEngineForRun,
  buildMuseAcpConfig,
  testMuseAcpEnvironment,
  type MuseExecutionEngine,
  type MuseEngineSelection,
} from "./acp.js";
export {
  MUSE_DEVICE_LOGIN_COMMAND,
  parseMuseDeviceLoginPrompt,
  type MuseDeviceLoginPrompt,
} from "./device-login-parse.js";

export const loginCapability = {
  panelMode: "displayed_code" as const,
  timeoutPolicy: "caller_bounded" as const,
  getCommand: () => "muse login",
  parsePrompt: (output: string) => {
    const urlMatch = output.match(/https?:\/\/[^\s]+/);
    const codeMatch = output.match(/code:\s*([A-Z0-9-]+)/i) || output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (!urlMatch || !codeMatch) return null;
    return {
      url: urlMatch[0],
      code: codeMatch[1],
    };
  },
};

export {
  listMuseSkills,
  syncMuseSkills,
  listMuseSkills as listSkills,
  syncMuseSkills as syncSkills,
} from "./skills.js";
export { decideMuseAuthMerge } from "./muse-auth-merge-decision.js";

import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { models, agentConfigurationDoc } from "../index.js";
import { sessionCodec } from "./session.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listMuseSkills, syncMuseSkills } from "./skills.js";

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  if (typeof config?.command === "string" && config.command.trim().length > 0) {
    return config.command.trim();
  }
  return fallback;
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "muse_local",
    runtimeToolDelivery: "environment",
    execute,
    testEnvironment,
    sessionCodec,
    loginCapability,
    acp: {
      agentId: "muse",
      skillsMode: "ephemeral",
      prerequisites: {
        nodeRange: ">=20.0.0",
      },
    },
    listSkills: listMuseSkills,
    syncSkills: syncMuseSkills,
    supportsToolRefreshOnResume: true,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    getRuntimeCommandSpec: (config) => ({
      command: readConfiguredCommand(config, "/home/localish/.local/bin/muse"),
      detectCommand: readConfiguredCommand(config, "/home/localish/.local/bin/muse"),
      installCommand: null,
    }),
    agentConfigurationDoc,
    getConfigSchema: () => ({ fields: [] }),
  };
}
