export { execute } from "./execute.js";
export { testEnvironment, readOllamaAuthStatus } from "./test.js";
export { ensureOllamaModelPulled, probeOllamaReachable, listPulledOllamaModels } from "./prepare.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * ollama_local has no resumable session concept in v1 — every run is a single
 * round-trip to /api/chat. The codec is a no-op so the runtime treats each
 * heartbeat as a fresh conversation.
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
