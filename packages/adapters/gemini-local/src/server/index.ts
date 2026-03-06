export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  parseGeminiStreamJson,
  describeGeminiFailure,
  isGeminiTurnLimitResult,
} from "./parse.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

// Gemini CLI does not currently support headless session resume.
// Each run is a fresh session. This minimal codec satisfies the interface.
export const sessionCodec: AdapterSessionCodec = {
  deserialize(_raw: unknown) {
    return null;
  },
  serialize(_params: Record<string, unknown> | null) {
    return null;
  },
  getDisplayId(_params: Record<string, unknown> | null) {
    return null;
  },
};
