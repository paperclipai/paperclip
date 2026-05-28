/**
 * External adapter entry point.
 * Paperclip's plugin loader calls createServerAdapter() to get the module.
 */
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./server/execute.js";
import { testEnvironment } from "./server/test.js";
import { type as adapterType, models, agentConfigurationDoc } from "./index.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: adapterType,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: false,
  };
}
