import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute, buildRequestUrl, buildChatMessages, parseChatCompletionStream, resolveApiSurface } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { computeCostUsd, resolveModelPrice } from "./pricing.js";
export { resolveAuthHeaders, resolveAuthMode, DEFAULT_AAD_SCOPE, _resetAuthCachesForTests } from "./auth.js";
export {
  buildResponsesBody,
  extractUsageFromResponses,
  parseResponsesJson,
  parseResponsesStream,
} from "./responses-api.js";

/**
 * Azure OpenAI is stateless per request — there is no server-managed session
 * to resume — so the codec is a no-op. Cross-run continuity for tasks is
 * handled by Paperclip's normal wake-payload machinery (task history, recovery
 * envelopes) which is rendered into the prompt on every heartbeat.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize() {
    return null;
  },
  serialize() {
    return null;
  },
  getDisplayId() {
    return null;
  },
};
