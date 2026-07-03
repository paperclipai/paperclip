import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc } from "../index.js";
import { execute } from "./gateway-execute.js";
import { testEnvironment } from "./gateway-test.js";
import { sessionCodec } from "./session.js";
import { getConfigSchema } from "./config-schema.js";

export { execute } from "./gateway-execute.js";
export { testEnvironment } from "./gateway-test.js";
export { sessionCodec } from "./session.js";
export { getConfigSchema } from "./config-schema.js";

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
