import type {
  AdapterSessionCodec,
  ServerAdapterModule,
} from '@paperclipai/adapter-utils';
import { getAdapterSessionManagement } from '@paperclipai/adapter-utils';
import { type, models, agentConfigurationDoc } from '../index.js';
import { execute } from './execute.js';
import { testEnvironment } from './test.js';
import { getConfigSchema } from './config-schema.js';
import { listDevinSkills, syncDevinSkills } from './skills.js';
import { detectModel, listDevinModels, refreshDevinModels } from './models.js';

export { execute } from './execute.js';
export { testEnvironment } from './test.js';
export { getConfigSchema } from './config-schema.js';
export { listDevinSkills, syncDevinSkills } from './skills.js';
export {
  listDevinModels as listModels,
  refreshDevinModels as refreshModels,
  listDevinBaseModels,
  resolveDevinModelUid,
  type DevinBaseModel,
} from './models.js';
export {
  isDevinUnknownSessionError,
  describeDevinFailure,
  extractDevinAnswer,
} from './parse.js';
export { resolveRunUsageAndCost } from './usage.js';
import { readResumeBaseline } from './usage.js';

function readNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Session codec: persists the Devin session id + the cwd it was created in so the
 * executor can do cwd-aware resume.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return null;
    const r = raw as Record<string, unknown>;
    const sessionId = readNonEmpty(r.sessionId) ?? readNonEmpty(r.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmpty(r.cwd) ?? readNonEmpty(r.workdir) ?? readNonEmpty(r.folder);
    const resumeBaseline = readResumeBaseline(r.resumeBaseline);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(resumeBaseline ? { resumeBaseline } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmpty(params.sessionId) ?? readNonEmpty(params.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmpty(params.cwd) ??
      readNonEmpty(params.workdir) ??
      readNonEmpty(params.folder);
    const resumeBaseline = readResumeBaseline(params.resumeBaseline);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(resumeBaseline ? { resumeBaseline } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmpty(params.sessionId) ?? readNonEmpty(params.session_id) ?? null
    );
  },
};

/**
 * Single source of truth for the devin_local ServerAdapterModule. Consumed both
 * by the in-repo registry (server/src/adapters/registry.ts) and by the external
 * `.paperclip` plugin shim, so the two can never drift.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    runtimeToolDelivery: 'environment',
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement: getAdapterSessionManagement(type) ?? undefined,
    models,
    listModels: listDevinModels,
    refreshModels: refreshDevinModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: 'instructionsFilePath',
    requiresMaterializedRuntimeSkills: true,
    getRuntimeCommandSpec: (config) => {
      const command = readNonEmpty(config.command) ?? 'devin';
      // installCommand stays null: self-install would mean piping an unpinned
      // remote script to bash, and this adapter does not join the remote/
      // sandbox provisioning surfaces where an install command would run
      // (REMOTE_MANAGED_ADAPTERS exclusion is deliberate).
      return { command, detectCommand: command, installCommand: null };
    },
    agentConfigurationDoc,
    getConfigSchema,
    detectModel,
    listSkills: listDevinSkills,
    syncSkills: syncDevinSkills,
  };
}
