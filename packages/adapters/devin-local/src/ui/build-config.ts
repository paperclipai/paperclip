import {
  buildAdapterEnvConfig,
  type CreateConfigValues,
} from '@paperclipai/adapter-utils';

function parseCommaArgs(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const VALID_PERMISSION_MODES = new Set([
  'normal',
  'auto',
  'accept-edits',
  'smart',
  'dangerous',
  'autonomous',
]);

function extra<T>(v: CreateConfigValues, key: string, fallback: T): T {
  const raw = v.adapterSchemaValues?.[key];
  return raw === undefined ? fallback : (raw as T);
}

export function buildDevinLocalConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.model) ac.model = v.model;

  const effort = (v.thinkingEffort || extra(v, 'thinkingEffort', '')) as string;
  if (effort && effort !== 'auto') ac.thinkingEffort = effort;

  const contextSize = extra<string>(v, 'contextSize', 'default');
  if (contextSize && contextSize !== 'default') ac.contextSize = contextSize;
  if (extra<boolean>(v, 'fastMode', false)) ac.fastMode = true;
  if (extra<boolean>(v, 'priority', false)) ac.priority = true;

  // Fail closed: an unset or unrecognized mode lands on `auto` (the CLI's own
  // default), never on a more permissive mode. The create form's segmented
  // control shows `auto` for an untouched field; this builder must agree.
  const permissionMode = extra<string>(v, 'permissionMode', 'auto');
  ac.permissionMode = VALID_PERMISSION_MODES.has(permissionMode)
    ? permissionMode
    : 'auto';

  if (extra<boolean>(v, 'respectWorkspaceTrust', false)) {
    ac.respectWorkspaceTrust = true;
  }
  if (extra<boolean>(v, 'sandbox', false)) {
    ac.sandbox = true;
  }

  ac.timeoutSec =
    typeof v.timeoutSec === 'number' &&
    Number.isFinite(v.timeoutSec) &&
    v.timeoutSec >= 0
      ? v.timeoutSec
      : 1800;
  const graceSec = extra<number>(v, 'graceSec', 15);
  ac.graceSec = Number.isFinite(graceSec) && graceSec >= 0 ? graceSec : 15;

  const exportPath = extra<string>(v, 'exportPath', '');
  if (exportPath) ac.exportPath = exportPath;

  if (v.command) ac.command = v.command;

  const extraArgs = extra<string>(v, 'extraArgs', '');
  if (extraArgs) ac.extraArgs = parseCommaArgs(extraArgs);

  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;

  return ac;
}
