
import { DEFAULT_TIMEOUT_SEC } from '../shared/constants.js';
import { normalizeEnvBindings } from '../shared/utils.js';

/**
 * Build adapterConfig from a Paperclip-like UI values object.
 *
 * This intentionally maps more fields than the previous Hermes adapter work,
 * so the generated config actually matches the documented adapter surface.
 *
 * @param {Record<string, any>} values
 */
export function buildHermesConfig(values) {
  const config = {};

  if (typeof values.model === 'string' && values.model.trim()) config.model = values.model.trim();
  if (typeof values.provider === 'string' && values.provider.trim()) config.provider = values.provider.trim();
  if (typeof values.cwd === 'string' && values.cwd.trim()) config.cwd = values.cwd.trim();
  if (typeof values.hermesHome === 'string' && values.hermesHome.trim()) {
    config.env = { ...(config.env || {}), HERMES_HOME: values.hermesHome.trim() };
  }
  if (typeof values.instructionsFilePath === 'string' && values.instructionsFilePath.trim()) config.instructionsFilePath = values.instructionsFilePath.trim();
  if (typeof values.promptTemplate === 'string' && values.promptTemplate.trim()) config.promptTemplate = values.promptTemplate;
  if (typeof values.bootstrapPrompt === 'string' && values.bootstrapPrompt.trim()) config.bootstrapPromptTemplate = values.bootstrapPrompt;
  if (typeof values.command === 'string' && values.command.trim()) {
    config.command = values.command.trim();
    config.hermesCommand = values.command.trim();
  }

  if (typeof values.toolsets === 'string' && values.toolsets.trim()) {
    config.toolsets = values.toolsets.trim();
  }

  config.timeoutSec = Number.isFinite(values.timeoutSec) ? values.timeoutSec : DEFAULT_TIMEOUT_SEC;
  config.graceSec = Number.isFinite(values.graceSec) ? values.graceSec : 20;

  if (Number.isFinite(values.maxTurnsPerRun) && values.maxTurnsPerRun > 0) {
    config.maxTurnsPerRun = values.maxTurnsPerRun;
    config.timeoutSec = Math.max(config.timeoutSec, values.maxTurnsPerRun * 20);
  }

  config.persistSession = values.persistSession !== false;
  config.worktreeMode = Boolean(values.worktreeMode || values.workspaceStrategyType === 'worktree');
  config.checkpoints = Boolean(values.checkpoints);
  config.verbose = Boolean(values.verbose);
  config.quiet = Boolean(values.quiet);
  config.dangerouslySkipPermissions =
    typeof values.dangerouslySkipPermissions === 'boolean'
      ? values.dangerouslySkipPermissions
      : true;

  if (typeof values.thinkingEffort === 'string' && values.thinkingEffort.trim()) {
    const extraArgs = [];
    const rawArgs = typeof values.extraArgs === 'string' ? values.extraArgs.split(/\s+/).filter(Boolean) : [];
    extraArgs.push(...rawArgs);
    extraArgs.push('--reasoning-effort', values.thinkingEffort.trim());
    config.extraArgs = extraArgs;
  } else if (typeof values.extraArgs === 'string' && values.extraArgs.trim()) {
    config.extraArgs = values.extraArgs.split(/\s+/).filter(Boolean);
  }

  const env = {
    ...(config.env || {}),
    ...normalizeEnvBindings(values.envBindings),
    ...parseEnvText(typeof values.envVars === 'string' ? values.envVars : ''),
  };
  if (Object.keys(env).length) config.env = env;

  return config;
}

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}
