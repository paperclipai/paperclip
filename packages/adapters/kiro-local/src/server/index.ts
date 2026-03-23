import type { ServerAdapterModule, AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { execute as executeImpl, ensureKiroSkillsInjected, type KiroSkillsOptions } from "./execute.js";
import { testEnvironment as testEnvironmentImpl } from "./test.js";
import { type, models, agentConfigurationDoc } from "../index.js";

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

// Import dynamic model discovery for use in adapter module
import { listKiroModels } from "./models.js";

// Re-export models constant and dynamic discovery
export { KIRO_MODELS, listKiroModels, resetKiroModelsCacheForTests, setKiroModelsRunnerForTests, parseKiroModelsOutput } from "./models.js";

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
    const sessionId = typeof params.sessionId === "string" && params.sessionId.trim().length > 0
      ? params.sessionId.trim()
      : null;
    if (!sessionId) return null;
    return {
      sessionId,
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
