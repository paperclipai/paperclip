
import path from 'node:path';
import { KNOWN_PROVIDER_ENV_KEYS } from '../shared/constants.js';
import {
  asRecord,
  asTrimmedString,
  readFileIfExists,
  readFileIfExistsSync,
  resolveHermesHome,
} from '../shared/utils.js';

/**
 * Parse a simple dotenv file.
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * @param {{config?: Record<string, unknown>, envPath?: string}=} options
 */
export async function readHermesEnvFile(options = {}) {
  const envPath = options.envPath || path.join(resolveHermesHome(options.config || {}), '.env');
  const content = await readFileIfExists(envPath);
  return content ? parseDotEnv(content) : {};
}

/**
 * @param {{config?: Record<string, unknown>, envPath?: string}=} options
 */
export function readHermesEnvFileSync(options = {}) {
  const envPath = options.envPath || path.join(resolveHermesHome(options.config || {}), '.env');
  const content = readFileIfExistsSync(envPath);
  return content ? parseDotEnv(content) : {};
}

/**
 * Return human-readable provider names based on env presence.
 *
 * @param {...Record<string,string>} envSources
 */
export function detectAvailableProviders(...envSources) {
  const merged = Object.assign({}, ...envSources);
  const providers = [];
  for (const [provider, keys] of Object.entries(KNOWN_PROVIDER_ENV_KEYS)) {
    if (keys.some((key) => asTrimmedString(merged[key]))) providers.push(provider);
  }
  return providers;
}

/**
 * @param {Record<string, unknown>} config
 */
export function extractResolvedConfigEnv(config) {
  const env = {};
  const input = asRecord(config.env);
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'string' && raw.trim()) env[key] = raw;
  }
  return env;
}
