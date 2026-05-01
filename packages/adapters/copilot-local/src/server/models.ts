import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { ensurePathInEnv, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { models as staticCopilotModels } from "../index.js";

const execFileAsync = promisify(execFile);
const MODELS_CACHE_TTL_MS = 1_800 * 1_000;
const NPM_DISCOVERY_TIMEOUT_MS = 4_000;

const FALLBACK_MODELS: AdapterModel[] = sortModels(
  dedupeModels(staticCopilotModels.map((model) => ({ id: model.id, label: model.label }))),
);

let discoveryCache: { expiresAt: number; models: AdapterModel[] } | null = null;

function firstToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function titleCaseToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return "";
  if (/^\d+(\.\d+)?$/.test(normalized)) return normalized;
  if (/^\d+[a-z]+$/.test(normalized)) return normalized.replace(/[a-z]+$/g, (suffix) => suffix.toUpperCase());
  if (normalized === "gpt") return "GPT";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function labelForModelId(modelId: string): string {
  const id = modelId.trim();
  if (!id) return modelId;
  if (id === "auto") return "Auto (default)";

  const tokens = id.split("-").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return id;

  if (tokens[0] === "gpt") {
    if (tokens.length > 1 && /^\d+(\.\d+)?$/.test(tokens[1])) {
      const suffix = tokens.slice(2).map(titleCaseToken).filter(Boolean).join(" ");
      return suffix ? `GPT-${tokens[1]} ${suffix}` : `GPT-${tokens[1]}`;
    }
    return ["GPT", ...tokens.slice(1).map(titleCaseToken).filter(Boolean)].join(" ");
  }

  if (tokens[0] === "claude") {
    return ["Claude", ...tokens.slice(1).map(titleCaseToken).filter(Boolean)].join(" ");
  }

  return tokens.map(titleCaseToken).filter(Boolean).join(" ");
}

function toModelList(ids: Iterable<string>): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    parsed.push({ id, label: labelForModelId(id) });
  }
  return sortModels(dedupeModels(parsed));
}

function mergeWithFallbackModels(models: AdapterModel[]): AdapterModel[] {
  return sortModels(dedupeModels([...models, ...FALLBACK_MODELS]));
}

function extractSupportedModelIds(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      return typeof record.id === "string" ? [record.id] : [];
    });
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const idsFromValues = Object.values(record).flatMap((value) => {
      if (typeof value === "string") return [value];
      if (typeof value !== "object" || value === null) return [];
      const model = value as Record<string, unknown>;
      return typeof model.id === "string" ? [model.id] : [];
    });
    const idsFromKeys = Object.keys(record).filter((key) => key.includes("-"));
    return [...idsFromValues, ...idsFromKeys];
  }
  return [];
}

function extractSupportedModelIdsFromModule(moduleValue: unknown): string[] {
  if (typeof moduleValue !== "object" || moduleValue === null) return [];
  const record = moduleValue as Record<string, unknown>;
  const defaultRecord =
    typeof record.default === "object" && record.default !== null
      ? (record.default as Record<string, unknown>)
      : null;
  const root = defaultRecord ?? record;
  const visible = extractSupportedModelIds(root.HELP_VISIBLE_MODELS ?? record.HELP_VISIBLE_MODELS);
  const supported = extractSupportedModelIds(root.SUPPORTED_MODELS ?? record.SUPPORTED_MODELS);
  const hidden = new Set(extractSupportedModelIds(root.HIDDEN_MODELS ?? record.HIDDEN_MODELS));
  const excluded = new Set(extractSupportedModelIds(root.EXCLUDED_MODELS ?? record.EXCLUDED_MODELS));
  const selected = visible.length > 0 ? visible : supported;
  return selected.filter((id) => !hidden.has(id) && !excluded.has(id));
}

/** Candidate relative paths from a @github/copilot package root to the SDK entry. */
const SDK_RELATIVE_PATHS = [
  "sdk/index.js",
  "dist/sdk/index.js",
  "lib/sdk/index.js",
  "dist/sdk.js",
] as const;

/**
 * Try to load the SDK module directly via dynamic import (bypasses CJS exports restrictions).
 * Falls back to createRequire for older package layouts that support CJS.
 */
async function loadSupportedModelIdsFromNodeModules(nodeModulesDir: string): Promise<string[]> {
  const copilotPkgDir = path.join(nodeModulesDir, "@github", "copilot");

  // Strategy 1: Direct file import — handles packages that only export ESM via `exports`.
  for (const relPath of SDK_RELATIVE_PATHS) {
    const candidate = path.join(copilotPkgDir, relPath);
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      const moduleValue = await import(pathToFileURL(candidate).href);
      const ids = extractSupportedModelIdsFromModule(moduleValue);
      if (ids.length > 0) return ids;
    } catch {
      // Continue to next candidate path.
    }
  }

  // Strategy 2: createRequire — works for packages that expose CJS or have a `require` export condition.
  const requireFrom = createRequire(path.join(nodeModulesDir, "__paperclip_copilot_models__.js"));
  const cjsSpecifiers = [
    "@github/copilot",
    "@github/copilot/sdk",
    "@github/copilot/dist/sdk",
    "@github/copilot/models",
  ] as const;
  for (const specifier of cjsSpecifiers) {
    try {
      const moduleValue = requireFrom(specifier);
      const ids = extractSupportedModelIdsFromModule(moduleValue);
      if (ids.length > 0) return ids;
    } catch {
      // Continue to next specifier.
    }
  }

  return [];
}

async function resolveNpmGlobalRoot(): Promise<string | null> {
  try {
    const env = ensurePathInEnv({ ...process.env });
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      cwd: process.cwd(),
      env,
      timeout: NPM_DISCOVERY_TIMEOUT_MS,
    });
    const root = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function deriveNodeModulesCandidatesFromCommandPath(commandPath: string): string[] {
  const resolved = path.resolve(commandPath);
  const candidates = new Set<string>();

  // If the resolved path is inside node_modules (e.g. .../lib/node_modules/@github/copilot/npm-loader.js),
  // extract the node_modules root directly — this is the most reliable candidate.
  const segments = resolved.split(path.sep);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === "node_modules") {
      candidates.add(segments.slice(0, i + 1).join(path.sep));
      break;
    }
  }

  // Walk up from the command directory looking for node_modules directories.
  let cursor = path.dirname(resolved);
  while (true) {
    if (path.basename(cursor) === "node_modules") {
      candidates.add(cursor);
    } else {
      candidates.add(path.join(cursor, "node_modules"));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [...candidates];
}

async function resolveCommandCandidates(): Promise<string[]> {
  const command = firstToken(
    typeof process.env.PAPERCLIP_COPILOT_COMMAND === "string" && process.env.PAPERCLIP_COPILOT_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_COPILOT_COMMAND
      : "copilot",
  );
  if (!command) return [];

  const env = ensurePathInEnv({ ...process.env });
  const resolved = await resolveCommandForLogs(command, process.cwd(), env);
  const candidates = new Set<string>();
  if (path.isAbsolute(resolved)) {
    candidates.add(resolved);
    // Follow symlinks to find the real install location (e.g. Homebrew, nvm).
    try {
      const realPath = await fs.promises.realpath(resolved);
      if (realPath !== resolved) candidates.add(realPath);
    } catch {
      // realpath may fail if the target doesn't exist; ignore.
    }
  }
  if (command.includes("/") || command.includes("\\")) {
    candidates.add(path.resolve(process.cwd(), command));
  }
  return [...candidates];
}

async function discoverNodeModulesCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  const npmGlobalRoot = await resolveNpmGlobalRoot();
  if (npmGlobalRoot) candidates.add(npmGlobalRoot);

  const commandCandidates = await resolveCommandCandidates();
  for (const commandPath of commandCandidates) {
    candidates.add(path.dirname(commandPath));
    for (const nodeModulesPath of deriveNodeModulesCandidatesFromCommandPath(commandPath)) {
      candidates.add(nodeModulesPath);
    }
  }

  return [...candidates];
}

async function discoverSupportedModelsFromSdk(): Promise<AdapterModel[] | null> {
  const nodeModulesCandidates = await discoverNodeModulesCandidates();
  for (const candidate of nodeModulesCandidates) {
    try {
      const ids = await loadSupportedModelIdsFromNodeModules(candidate);
      if (ids.length > 0) return toModelList(ids);
    } catch {
      // Best-effort discovery; continue to next candidate.
    }
  }
  return null;
}

export async function listCopilotModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.models;

  try {
    const discovered = await discoverSupportedModelsFromSdk();
    const models = discovered && discovered.length > 0 ? mergeWithFallbackModels(discovered) : FALLBACK_MODELS;
    discoveryCache = { expiresAt: now + MODELS_CACHE_TTL_MS, models };
    return models;
  } catch {
    discoveryCache = { expiresAt: now + MODELS_CACHE_TTL_MS, models: FALLBACK_MODELS };
    return FALLBACK_MODELS;
  }
}

export function resetCopilotModelsCacheForTests() {
  discoveryCache = null;
}
