export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to null return
      }
    }
    return null;
  },
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return (params.sessionId as string) ?? (params.id as string) ?? null;
  },
};
