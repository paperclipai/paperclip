
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MEANINGLESS_PLACEHOLDER_STRINGS = new Set(['none', 'null', 'undefined']);

/** @param {unknown} value */
export function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** @param {unknown} value */
export function asTrimmedString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (MEANINGLESS_PLACEHOLDER_STRINGS.has(trimmed.toLowerCase())) return fallback;
  return trimmed;
}

/** @param {unknown} value */
export function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** @param {unknown} value */
export function asNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** @param {unknown} value */
export function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

/** @param {unknown} value */
export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function nowIso() {
  return new Date().toISOString();
}

/** @param {string} value */
export function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

/** @param {string} value */
export function stripAnsi(value) {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

/** @param {string} value */
export function stableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {string} value */
export function redactTokenForDisplay(value) {
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function homedir() {
  return os.homedir();
}

/**
 * Resolve Hermes home.
 *
 * Precedence:
 * 1. adapterConfig.env.HERMES_HOME
 * 2. process.env.HERMES_HOME
 * 3. ~/.hermes
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function resolveHermesHome(config = {}) {
  const env = asRecord(config.env);
  const explicit = asTrimmedString(env.HERMES_HOME) || asTrimmedString(process.env.HERMES_HOME);
  return explicit ? path.resolve(explicit) : path.join(homedir(), '.hermes');
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
  return dirPath;
}

export function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function readFileIfExistsSync(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export async function readFileIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function fileExistsSync(filePath) {
  try {
    return fs.statSync(filePath).isFile() || fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Minimal template renderer.
 * Supports {{key}} flat replacement and does not attempt full Mustache parity.
 *
 * @param {string} template
 * @param {Record<string, unknown>} vars
 */
export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), vars);
    return value == null ? '' : String(value);
  });
}

/**
 * Render a simple conditional block syntax:
 * {{#key}}...{{/key}}
 *
 * @param {string} template
 * @param {Record<string, unknown>} vars
 */
export function renderConditionals(template, vars) {
  return template.replace(/\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, key, body) => {
    const value = key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), vars);
    return value ? body : '';
  });
}

/**
 * Safe env merge.
 *
 * The adapter intentionally does not forward the entire host environment blindly.
 * It keeps PATH/HOME/TMP-like process essentials and then overlays adapter + Paperclip vars.
 *
 * @param {Record<string, string>} baseEnv
 * @param {Record<string, string>} overlay
 */
export function mergeRuntimeEnv(baseEnv, overlay) {
  const keep = ['PATH', 'HOME', 'TMP', 'TMPDIR', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'SHELL'];
  const merged = {};
  for (const key of keep) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) merged[key] = baseEnv[key];
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}

/**
 * Normalize env bindings from Paperclip edit/create flows.
 *
 * Supports:
 * - plain string values
 * - { type: "plain", value: "..." }
 * - { type: "secret_ref", secretId: "...", value: "..." }  -> value only when already resolved
 *
 * @param {unknown} input
 */
export function normalizeEnvBindings(input) {
  const source = asRecord(input);
  const env = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === 'string') {
      env[key] = raw;
      continue;
    }
    const record = asRecord(raw);
    if (record.type === 'plain' && typeof record.value === 'string') {
      env[key] = record.value;
      continue;
    }
    if (typeof record.value === 'string') {
      env[key] = record.value;
    }
  }
  return env;
}

export function joinPromptSections(sections) {
  return sections.map((section) => String(section ?? '').trim()).filter(Boolean).join('\n\n');
}
