import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
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
    execute,
    testEnvironment,
    models,
    modelProfiles,
    agentConfigurationDoc,
    supportsInstructionsBundle,
    instructionsPathKey,
    requiresMaterializedRuntimeSkills,
    supportsLocalAgentJwt,
  } as ServerAdapterModule & { label: string };
}
