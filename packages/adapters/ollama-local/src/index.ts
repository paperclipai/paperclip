/**
 * Top-level package export.
 *
 * The Paperclip adapter-plugin loader (server/src/adapters/plugin-loader.ts)
 * resolves the package's "." export and expects a createServerAdapter()
 * function. That function is defined in ./server/index.js and re-exported
 * here so the main entry matches the plugin-loader contract.
 *
 * Constants live in ./constants.js so both this module and ./server can
 * consume them without a circular import.
 */
export {
  type,
  label,
  models,
  agentConfigurationDoc,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  DEFAULT_OLLAMA_KEEP_ALIVE_SEC,
  DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC,
  DEFAULT_OLLAMA_TEMPERATURE,
  DEFAULT_OLLAMA_TOP_P,
} from "./constants.js";

export { createServerAdapter } from "./server/index.js";
