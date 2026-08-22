import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc } from "../index.js";
import { execute } from "./gateway-execute.js";
import { execute as localExecute } from "./local-execute.js";
import { testEnvironment } from "./gateway-test.js";
import { testEnvironment as localTestEnvironment } from "./local-test.js";
import { sessionCodec } from "./session.js";
import { getConfigSchema, getLocalConfigSchema } from "./config-schema.js";

export { execute } from "./gateway-execute.js";
export { execute as localExecute } from "./local-execute.js";
export { testEnvironment } from "./gateway-test.js";
export { testEnvironment as localTestEnvironment } from "./local-test.js";
export { sessionCodec } from "./session.js";
export { getConfigSchema, getLocalConfigSchema } from "./config-schema.js";

export function createEveGatewayServerAdapter(): ServerAdapterModule {
  return {
    type: "eve_gateway",
    execute,
    testEnvironment,
    sessionCodec,
    models: [],
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}

export function createEveLocalServerAdapter(): ServerAdapterModule {
  return {
    type: "eve_local",
    execute: localExecute,
    testEnvironment: localTestEnvironment,
    sessionCodec,
    models: [],
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema: getLocalConfigSchema,
  };
}
