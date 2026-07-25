import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
    const model = typeof value.model === "string" ? value.model.trim() : "";
    return model ? { ...(baseUrl ? { baseUrl } : {}), model } : null;
  },
  serialize(params) {
    if (!params || typeof params.model !== "string" || !params.model.trim()) return null;
    return {
      ...(typeof params.baseUrl === "string" && params.baseUrl.trim() ? { baseUrl: params.baseUrl.trim() } : {}),
      model: params.model.trim(),
    };
  },
  getDisplayId(params) {
    return typeof params?.model === "string" && params.model.trim() ? params.model.trim() : null;
  },
};
