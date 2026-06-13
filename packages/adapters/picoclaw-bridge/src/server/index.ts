import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { type, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listPicoSkills, syncPicoSkills } from "./skills.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    listSkills: listPicoSkills,
    syncSkills: syncPicoSkills,
  };
}
