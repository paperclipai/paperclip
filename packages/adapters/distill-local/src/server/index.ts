import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(raw: Record<string, unknown>) {
  const sessionId = readNonEmptyString(raw.sessionId) ?? readNonEmptyString(raw.session_id);
  if (!sessionId) return null;
  const cwd = readNonEmptyString(raw.cwd);
  const workspaceId = readNonEmptyString(raw.workspaceId);
  const repoUrl = readNonEmptyString(raw.repoUrl);
  const repoRef = readNonEmptyString(raw.repoRef);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return normalize(raw as Record<string, unknown>);
  },
  serialize(params: Record<string, unknown> | null) {
    return params ? normalize(params) : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return params ? readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id) : null;
  },
};

export { execute } from "./execute.js";
export { listDistillSkills, syncDistillSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { discoverDistillModels } from "./models.js";
export { parseDistillJsonl, parseDistillModelsOutput, isDistillUnknownSessionError } from "./parse.js";
