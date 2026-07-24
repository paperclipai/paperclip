import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute, buildRequestUrl, buildChatMessages, parseChatCompletionStream } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { computeCostUsd, resolveModelPrice } from "./pricing.js";

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
