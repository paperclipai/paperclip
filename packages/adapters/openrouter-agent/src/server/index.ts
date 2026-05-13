import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listModels, refreshModels, detectModel } from "./models.js";
import { getConfigSchema } from "./config-schema.js";
import { listSkills, syncSkills } from "./skills.js";
import {
  type,
  label,
  models,
  modelProfiles,
  agentConfigurationDoc,
  supportsInstructionsBundle,
  instructionsPathKey,
  requiresMaterializedRuntimeSkills,
  supportsLocalAgentJwt,
} from "../index.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listModels, refreshModels, detectModel } from "./models.js";
export { getConfigSchema } from "./config-schema.js";
export {
  loadInstructionFragments,
  joinInstructionFragments,
} from "./instructions.js";
export {
  DEFAULT_TOOLS,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  RUN_COMMAND_TOOL,
  APPLY_PATCH_TOOL,
  buildToolMap,
  dispatchToolCall,
  parseToolArguments,
  toOpenAiTools,
  runShellCommand,
} from "./tools.js";
export type { ToolHandler, ToolContext, ToolDispatchOutcome } from "./tools.js";

export {
  type,
  label,
  models,
  modelProfiles,
  agentConfigurationDoc,
  supportsInstructionsBundle,
  instructionsPathKey,
  requiresMaterializedRuntimeSkills,
  supportsLocalAgentJwt,
};

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    label,
    execute,
    testEnvironment,
    models,
    modelProfiles,
    agentConfigurationDoc,
    supportsInstructionsBundle,
    instructionsPathKey,
    requiresMaterializedRuntimeSkills,
    supportsLocalAgentJwt,
    listModels,
    refreshModels,
    detectModel,
    getConfigSchema,
    listSkills,
    syncSkills,
  } as ServerAdapterModule & { label: string };
}
