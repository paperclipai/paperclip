import type { ServerAdapterModule, AdapterModel, AdapterEnvironmentTestResult, AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { execute as executeImpl, ensureKiroSkillsInjected, type KiroSkillsOptions } from "./execute.js";
import { testEnvironment as testEnvironmentImpl } from "./test.js";
import { type, models, agentConfigurationDoc, DEFAULT_KIRO_LOCAL_MODEL } from "../index.js";

// Re-export for registry consumption
export { executeImpl as execute };
export { testEnvironmentImpl as testEnvironment };

// Re-export skill injection for testing
export { ensureKiroSkillsInjected, type KiroSkillsOptions };

// Re-export parse utilities
export {
  stripAnsi,
  parseCredits,
  parseTimeSeconds,
  parseKiroOutput,
  isKiroUnknownSessionError,
} from "./parse.js";

// Re-export skill sync methods
export { listKiroSkills, syncKiroSkills } from "./skills.js";

// Re-export models constant (listKiroModels is defined locally below)
export { KIRO_MODELS } from "./models.js";

/**
 * Kiro session codec.
 *
 * Kiro uses SQLite for session storage at ~/.local/share/kiro-cli/data.sqlite3.
 * Sessions are identified by cwd path for resume purposes.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const params = raw as Record<string, unknown>;
    return {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
      repoUrl: typeof params.repoUrl === "string" ? params.repoUrl : null,
      repoRef: typeof params.repoRef === "string" ? params.repoRef : null,
    };
  },

  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
      repoUrl: typeof params.repoUrl === "string" ? params.repoUrl : null,
      repoRef: typeof params.repoRef === "string" ? params.repoRef : null,
    };
  },

  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return typeof params.sessionId === "string" ? params.sessionId : null;
  },
};

/**
 * List available Kiro models.
 */
export async function listKiroModels(): Promise<AdapterModel[]> {
  return [...models];
}

/**
 * Server adapter module for Kiro (local).
 */
export const kiroLocalAdapter: ServerAdapterModule = {
  type,
  execute: executeImpl,
  testEnvironment: testEnvironmentImpl,
  sessionCodec,
  models: [...models],
  listModels: listKiroModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc,
};
