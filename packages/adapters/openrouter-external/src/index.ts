// Shared metadata for the openai adapter.
//
// This module is imported by both the server runtime and (potentially) the
// UI plugin loader, so it must stay free of Node-only imports.

export {
  type,
  label,
  models,
  agentConfigurationDoc,
  supportsInstructionsBundle,
  instructionsPathKey,
  requiresMaterializedRuntimeSkills,
  supportsLocalAgentJwt,
  createServerAdapter,
} from "./server/index.js";
