export {
  ADAPTER_TYPE as type,
  ADAPTER_LABEL as label,
  DEFAULT_AIDER_LOCAL_MODEL,
  DEFAULT_AIDER_CHAT_HISTORY_FILE,
  models,
} from "./shared/constants.js";
export { agentConfigurationDoc } from "./shared/agent-configuration-doc.js";

// The external plugin loader imports the package root and calls
// createServerAdapter(). Built-in registration imports ./server directly, so
// both install paths resolve the same module.
export { createServerAdapter } from "./server/index.js";
