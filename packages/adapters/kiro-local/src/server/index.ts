import type { ServerAdapterModule, AdapterModel, AdapterEnvironmentTestResult, AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { type, models, agentConfigurationDoc, DEFAULT_KIRO_LOCAL_MODEL } from "../index.js";

/**
 * Kiro session codec.
 *
 * Kiro uses SQLite for session storage at ~/.local/share/kiro-cli/data.sqlite3.
 * Sessions are identified by cwd path for resume purposes.
 */
export const kiroSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const params = raw as Record<string, unknown>;
    return {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
    };
  },

  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
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
  execute,
  testEnvironment,
  sessionCodec: kiroSessionCodec,
  models: [...models],
  listModels: listKiroModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc,
};
