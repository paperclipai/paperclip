
import path from 'node:path';
import { MODEL_PREFIX_PROVIDER_HINTS, VALID_PROVIDERS } from '../shared/constants.js';
import {
  asRecord,
  asTrimmedString,
  fileExistsSync,
  readFileIfExists,
  readFileIfExistsSync,
  resolveHermesHome,
} from '../shared/utils.js';

/**
 * Parse a subset of YAML scalar values without taking a YAML dependency.
 *
 * The adapter only needs enough to extract model/provider/base_url/api_mode and
 * custom provider definitions from Hermes config.yaml.
 *
 * This parser:
 * - keeps indentation-based paths,
 * - supports quoted or plain scalars,
 * - strips inline comments when they are outside quotes,
 * - skips arrays for direct scalar extraction but preserves "- name: ..." forms
 *   for the custom provider list parser below.
 *
 * @param {string} content
 * @returns {Array<{path: string[], value: string}>}
 */
export function parseYamlScalars(content) {
  const entries = [];
  const stack = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '    ');
    const trimmedStart = line.trimStart();
    if (!trimmedStart || trimmedStart.startsWith('#')) continue;

    const indent = line.length - trimmedStart.length;

    // Array item with inline scalar object-ish shape, e.g. "- name: Local"
    if (trimmedStart.startsWith('- ')) {
      const itemBody = trimmedStart.slice(2);
      const match = itemBody.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = cleanYamlScalar(match[2]);
        const parentPath = stack.filter((entry) => entry.indent < indent).map((entry) => entry.key);
        const arrayPath = [...parentPath, '__item__', key];
        entries.push({ path: arrayPath, value });
      }
      continue;
    }

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const match = trimmedStart.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    if (!rawValue.length) {
      stack.push({ indent, key });
      continue;
    }

    entries.push({
      path: [...stack.map((entry) => entry.key), key],
      value: cleanYamlScalar(rawValue),
    });
  }

  return entries;
}

/**
 * @param {string} raw
 */
export function cleanYamlScalar(raw) {
  let inSingle = false;
  let inDouble = false;
  let value = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      value += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      value += char;
      continue;
    }
    if (char === '#' && !inSingle && !inDouble) {
      const prev = index === 0 ? ' ' : raw[index - 1];
      if (/\s/.test(prev)) break;
    }
    value += char;
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} content
 * @returns {null | {model: string, provider: string, baseUrl: string, apiMode: string, source: string}}
 */
export function parseModelFromConfig(content) {
  const scalars = parseYamlScalars(content);
  const lookup = new Map(scalars.map((entry) => [entry.path.join('.'), entry.value]));

  const model = lookup.get('model.default') || '';
  const provider = lookup.get('model.provider') || '';
  const baseUrl = lookup.get('model.base_url') || '';
  const apiMode = lookup.get('model.api_mode') || '';

  if (!model) return null;
  return { model, provider, baseUrl, apiMode, source: 'config' };
}

/**
 * Parse configured models from Hermes config.yaml.
 *
 * The goal is not to perfectly mirror every possible config structure.
 * The goal is to surface the models a Paperclip operator is likely to care about:
 * - the default runtime model,
 * - named custom providers,
 * - task-specific auxiliary model overrides,
 * - and fallback/compression models.
 *
 * @param {string} content
 * @returns {Array<{model: string, provider: string, sourcePath: string, isDefault: boolean, source: string}>}
 */
export function parseConfiguredModelsFromConfig(content) {
  const scalars = parseYamlScalars(content);
  const lookup = new Map(scalars.map((entry) => [entry.path.join('.'), entry.value]));
  const discovered = new Map();

  const defaultModel = lookup.get('model.default') || '';
  if (defaultModel) {
    const provider = lookup.get('model.provider') || '';
    discovered.set(`default:${defaultModel}:${provider}`, {
      model: defaultModel,
      provider,
      sourcePath: 'model.default',
      isDefault: true,
      source: 'config',
    });
  }

  for (const entry of scalars) {
    const pathText = entry.path.join('.');
    const last = entry.path[entry.path.length - 1];

    if (!entry.value) continue;
    if (['default', 'model'].includes(last) || last.endsWith('_model')) {
      const providerPath =
        last === 'default'
          ? pathText.replace(/default$/, 'provider')
          : last === 'model'
            ? pathText.replace(/model$/, 'provider')
            : pathText.replace(/_model$/, '_provider');
      const provider = lookup.get(providerPath) || '';
      const key = `${pathText}:${entry.value}:${provider}`;
      if (!discovered.has(key)) {
        discovered.set(key, {
          model: entry.value,
          provider,
          sourcePath: pathText,
          isDefault: pathText === 'model.default',
          source: 'config',
        });
      }
    }
  }

  // Custom provider array items: custom_providers -> __item__ -> {name, model, base_url}
  const customItems = [];
  let current = null;
  for (const entry of scalars) {
    if (entry.path[0] !== 'custom_providers' || entry.path[1] !== '__item__') continue;
    const field = entry.path[2];
    if (field === 'name') {
      if (current) customItems.push(current);
      current = { name: entry.value, model: '', provider: 'custom', sourcePath: 'custom_providers' };
    } else if (current) {
      current[field] = entry.value;
    }
  }
  if (current) customItems.push(current);
  for (const item of customItems) {
    if (!item.model) continue;
    const key = `custom:${item.name}:${item.model}`;
    if (!discovered.has(key)) {
      discovered.set(key, {
        model: item.model,
        provider: item.provider || 'custom',
        sourcePath: `custom_providers.${item.name}`,
        isDefault: false,
        source: 'config',
      });
    }
  }

  return [...discovered.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.sourcePath.localeCompare(b.sourcePath) || a.model.localeCompare(b.model);
  });
}

/**
 * @param {string} model
 * @returns {string | undefined}
 */
export function inferProviderFromModel(model) {
  const lower = model.toLowerCase();
  const bare = lower.includes('/') ? lower.split('/').pop() : lower;
  for (const [prefix, provider] of MODEL_PREFIX_PROVIDER_HINTS) {
    if (bare.startsWith(prefix)) return provider;
  }
  return undefined;
}

/**
 * Provider resolution priority:
 * 1. explicit adapterConfig.provider
 * 2. Hermes config provider when config model === requested model
 * 3. model prefix inference
 * 4. auto
 *
 * @param {{explicitProvider?: string|null, detectedProvider?: string, detectedModel?: string, model?: string}} options
 */
export function resolveProvider(options) {
  const explicitProvider = asTrimmedString(options.explicitProvider);
  const detectedProvider = asTrimmedString(options.detectedProvider);
  const detectedModel = asTrimmedString(options.detectedModel);
  const model = asTrimmedString(options.model);

  if (explicitProvider && VALID_PROVIDERS.includes(explicitProvider)) {
    return { provider: explicitProvider, resolvedFrom: 'adapterConfig' };
  }

  if (
    detectedProvider &&
    detectedModel &&
    model &&
    VALID_PROVIDERS.includes(detectedProvider) &&
    detectedModel.toLowerCase() === model.toLowerCase()
  ) {
    return { provider: detectedProvider, resolvedFrom: 'hermesConfig' };
  }

  if (model) {
    const inferred = inferProviderFromModel(model);
    if (inferred) return { provider: inferred, resolvedFrom: 'modelInference' };
  }

  return { provider: 'auto', resolvedFrom: 'auto' };
}

/**
 * @param {string | undefined} configPath
 */
export async function detectModel(configPath) {
  const filePath = configPath || path.join(resolveHermesHome({}), 'config.yaml');
  const content = await readFileIfExists(filePath);
  return content ? parseModelFromConfig(content) : null;
}

/**
 * @param {string | undefined} configPath
 */
export function detectModelSync(configPath) {
  const filePath = configPath || path.join(resolveHermesHome({}), 'config.yaml');
  const content = readFileIfExistsSync(filePath);
  return content ? parseModelFromConfig(content) : null;
}

/**
 * @param {string | undefined} configPath
 */
export async function listConfiguredModels(configPath) {
  const filePath = configPath || path.join(resolveHermesHome({}), 'config.yaml');
  const content = await readFileIfExists(filePath);
  return content ? parseConfiguredModelsFromConfig(content) : [];
}

/**
 * @param {string | undefined} configPath
 */
export function listConfiguredModelsSync(configPath) {
  const filePath = configPath || path.join(resolveHermesHome({}), 'config.yaml');
  const content = readFileIfExistsSync(filePath);
  return content ? parseConfiguredModelsFromConfig(content) : [];
}

/**
 * Small helper for environment tests and docs.
 *
 * @param {Record<string, unknown>} config
 */
export function detectConfiguredHermesHomePaths(config = {}) {
  const home = resolveHermesHome(config);
  return {
    hermesHome: home,
    configPath: path.join(home, 'config.yaml'),
    envPath: path.join(home, '.env'),
    authPath: path.join(home, 'auth.json'),
    skillsPath: path.join(home, 'skills'),
    stateDbPath: path.join(home, 'state.db'),
  };
}
