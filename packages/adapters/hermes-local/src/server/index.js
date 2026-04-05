
import { DEFAULT_AGENT_CONFIGURATION_DOC } from '../shared/constants.js';
import { getStaticHermesModels } from './list-models.js';

export { execute, createHermesExecutionPlan, buildExecutionEnv, resolveExecutionCwd, buildExecutionResult } from './execute.js';
export { testEnvironment } from './test.js';
export {
  detectModel,
  detectModelSync,
  parseModelFromConfig,
  parseConfiguredModelsFromConfig,
  inferProviderFromModel,
  resolveProvider,
  listConfiguredModels,
  listConfiguredModelsSync,
  detectConfiguredHermesHomePaths,
} from './detect-model.js';
export { listHermesModels, getStaticHermesModels, formatConfiguredModels, resetHermesModelsCacheForTests } from './list-models.js';
export { listHermesSkills as listSkills, syncHermesSkills as syncSkills, resolveHermesDesiredSkillNames as resolveDesiredSkillNames } from './skills.js';
export { getHermesConfigSchema as getConfigSchema } from './config-schema.js';
export { onHireApproved } from './hire-approved.js';
export { parseHermesOutput, parseHermesStdoutLine, createHermesStdoutParser, isUnknownSessionError } from './parse.js';

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Session codec that keeps enough metadata to avoid invalid cross-workspace
 * resume attempts.
 */
export const sessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = /** @type {Record<string, unknown>} */ (raw);
    const sessionId = readNonEmptyString(record.sessionId) || readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    const workspaceId = readNonEmptyString(record.workspaceId) || readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) || readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) || readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params) {
    if (!params || typeof params !== 'object') return null;
    const sessionId = readNonEmptyString(params.sessionId) || readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return {
      sessionId,
      ...(readNonEmptyString(params.cwd) ? { cwd: readNonEmptyString(params.cwd) } : {}),
      ...(readNonEmptyString(params.workspaceId) ? { workspaceId: readNonEmptyString(params.workspaceId) } : {}),
      ...(readNonEmptyString(params.repoUrl) ? { repoUrl: readNonEmptyString(params.repoUrl) } : {}),
      ...(readNonEmptyString(params.repoRef) ? { repoRef: readNonEmptyString(params.repoRef) } : {}),
    };
  },
  getDisplayId(params) {
    if (!params || typeof params !== 'object') return null;
    return readNonEmptyString(params.sessionId) || readNonEmptyString(params.session_id);
  },
};

/**
 * Optional convenience helper for external-adapter/plugin loaders.
 */
export function createServerAdapter() {
  return {
    type: 'hermes_local',
    execute: (ctx) => import('./execute.js').then((module) => module.execute(ctx)),
    testEnvironment: (ctx) => import('./test.js').then((module) => module.testEnvironment(ctx)),
    listSkills: (ctx) => import('./skills.js').then((module) => module.listHermesSkills(ctx)),
    syncSkills: (ctx, desired) => import('./skills.js').then((module) => module.syncHermesSkills(ctx, desired)),
    sessionCodec,
    supportsLocalAgentJwt: true,
    models: getStaticHermesModels(),
    listModels: () => import('./list-models.js').then((module) => module.listHermesModels()),
    agentConfigurationDoc: DEFAULT_AGENT_CONFIGURATION_DOC,
    getConfigSchema: () => import('./config-schema.js').then((module) => module.getHermesConfigSchema()),
    detectModel: () => import('./detect-model.js').then((module) => module.detectModel()),
    onHireApproved: (payload, config) => import('./hire-approved.js').then((module) => module.onHireApproved(payload, config)),
  };
}
