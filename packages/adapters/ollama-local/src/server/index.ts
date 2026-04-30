import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../constants.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOllamaSkills, syncOllamaSkills } from "./skills.js";
import { sessionCodec } from "./session-codec.js";
import { getOllamaConfigSchema } from "./config.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOllamaSkills, syncOllamaSkills } from "./skills.js";
export { sessionCodec } from "./session-codec.js";
export { resolveOllamaConfig, getOllamaConfigSchema } from "./config.js";
export {
  ollamaNdjsonLines,
  parseOllamaChatStream,
  type OllamaChatFrame,
  type OllamaChatFinalFrame,
  type ParsedOllamaStream,
} from "./parse.js";

/**
 * Plugin entrypoint used by the external adapter plugin-loader.
 *
 * See server/src/adapters/plugin-loader.ts — it resolves the package's main
 * entrypoint, imports it, and calls createServerAdapter().
 *
 * Returning the adapter from here (not from ../index.ts) keeps the top-level
 * module free of Node-only imports so it can be safely re-used from the UI
 * and CLI bundles.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listSkills: listOllamaSkills,
    syncSkills: syncOllamaSkills,
    sessionCodec,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema: () => getOllamaConfigSchema(),
  };
}
