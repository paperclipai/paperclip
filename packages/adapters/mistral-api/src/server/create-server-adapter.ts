import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { executeMistralRequest } from "./execute.js";
import { testMistralEnvironment } from "./test.js";
import { sessionCodec } from "./index.js";
import { agentConfigurationDoc, models } from "../index.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "mistral_api",
    execute: executeMistralRequest,
    testEnvironment: testMistralEnvironment,
    sessionCodec,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
  };
}