import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    const model = readNonEmptyString(record.model);
    const host = readNonEmptyString(record.host);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(host ? { host } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    const model = readNonEmptyString(params.model);
    const host = readNonEmptyString(params.host);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(host ? { host } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return params ? readNonEmptyString(params.sessionId) : null;
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
export {
  ensureSessionsDir,
  buildSessionPath,
  loadSession,
  saveSession,
  sessionMatchesCurrentRun,
} from "./session.js";
export type { OllamaSessionState, OllamaSessionMessage } from "./session.js";
