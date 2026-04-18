export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { 
  parseKimiStreamJson, 
  detectKimiLoginRequired,
  describeKimiFailure,
  isKimiUnknownSessionError,
  isKimiMaxStepsError,
} from "./parse.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    const obj = parseObject(raw);
    if (!obj) return null;
    const sessionId = asString(obj.sessionId, "");
    if (!sessionId) return null;
    return {
      sessionId,
      cwd: asString(obj.cwd, ""),
    };
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionId = asString(params.sessionId, "");
    if (!sessionId) return null;
    return {
      sessionId,
      cwd: asString(params.cwd, ""),
    };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    const sessionId = asString(params.sessionId, "");
    return sessionId || null;
  },
};
