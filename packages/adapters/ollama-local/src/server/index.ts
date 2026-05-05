import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * v0.1: session resume is not yet implemented. The codec is a no-op shim so the
 * adapter type slot exists; serialize() always returns null which signals "no
 * resumable session" to the host.
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

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  listOllamaModels,
  fetchOllamaTags,
  pullOllamaModel,
  deleteOllamaModel,
  showOllamaModel,
  modelSupportsTools,
  resolveOllamaHost,
  resolveOllamaApiKey,
  isOllamaCloudHost,
} from "./models.js";
export type { OllamaPullProgressEvent, OllamaShowResponse } from "./models.js";
export { listOllamaSkills, syncOllamaSkills } from "./skills.js";
