import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseOpenCodeResponse, isOpenCodeSessionNotFound } from "./parse.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    const rec = parseObject(raw);
    const sessionId = asString(rec.sessionId, "").trim();
    if (!sessionId) return null;
    return {
      sessionId,
      directory: asString(rec.directory, ""),
    };
  },

  serialize(
    params: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!params) return null;
    const sessionId = asString(params.sessionId, "").trim();
    if (!sessionId) return null;
    return {
      sessionId,
      directory: asString(params.directory, ""),
    };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return asString(params.sessionId, "").trim() || null;
  },
};
