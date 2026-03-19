import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { hydrateLiteLlmApiKey } from "./auth.js";

const DEFAULT_OPENCODE_COMMAND = "opencode";
const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
const OPENCODE_CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;
const ANSI_ESCAPE_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const TABLE_SEPARATOR_PATTERN = /^[\s|:-]+$/;
const PLAIN_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const NON_MODEL_TOKENS = new Set([
  "model",
  "models",
  "id",
  "name",
  "provider",
  "providers",
  "description",
  "status",
  "default",
  "available",
]);
type OpenCodeNamedItem = { id: string; label: string };
export type OpenCodeAgentProfile = OpenCodeNamedItem;

function resolveRuntimeHomeDir(): string {
  try {
    const homedir = os.userInfo().homedir;
    if (typeof homedir === "string" && homedir.trim().length > 0) {
      return homedir.trim();
    }
  } catch {
    // Fall back to os.homedir() when passwd lookup is unavailable.
  }
  return os.homedir();
}

function defaultOpenCodeCommandOverride(): string {
  return typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
    ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
    : DEFAULT_OPENCODE_COMMAND;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultOpenCodeCommandCandidates(homeDir: string): string[] {
  return [
    path.join(homeDir, ".opencode", "bin", "opencode"),
    path.join(homeDir, ".local", "bin", "opencode"),
    path.join(homeDir, ".bun", "bin", "opencode"),
    path.join(homeDir, ".config", "opencode", "node_modules", ".bin", "opencode"),
  ];
}

export function resolveOpenCodeCommand(
  input: unknown,
  options?: { homeDir?: string },
): string {
  const configured = asString(input, defaultOpenCodeCommandOverride()).trim() || DEFAULT_OPENCODE_COMMAND;
  if (configured !== DEFAULT_OPENCODE_COMMAND) return configured;

  const homeDir = options?.homeDir ?? resolveRuntimeHomeDir();
  for (const candidate of defaultOpenCodeCommandCandidates(homeDir)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return configured;
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const agentDiscoveryCache = new Map<string, { expiresAt: number; agents: OpenCodeAgentProfile[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

function dedupeNamedItems<T extends OpenCodeNamedItem>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ ...item, id, label: item.label.trim() || id });
  }
  return deduped;
}

function sortNamedItems<T extends OpenCodeNamedItem>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  return dedupeNamedItems(models);
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return sortNamedItems(models);
}

function dedupeAgents(agents: OpenCodeAgentProfile[]): OpenCodeAgentProfile[] {
  return dedupeNamedItems(agents);
}

function sortAgents(agents: OpenCodeAgentProfile[]): OpenCodeAgentProfile[] {
  return sortNamedItems(agents);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeModelToken(value: string): string {
  return value
    .trim()
    .replace(/^[*\-•]+\s*/, "")
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .replace(/[,:;]+$/, "")
    .trim();
}

function parseModelIdFromToken(token: string): string | null {
  const value = normalizeModelToken(token);
  if (!value) return null;
  if (TABLE_SEPARATOR_PATTERN.test(value)) return null;
  if (!PLAIN_MODEL_ID_PATTERN.test(value)) return null;
  if (NON_MODEL_TOKENS.has(value.toLowerCase())) return null;
  return value;
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    if (line.includes("|")) {
      for (const cell of line.split("|")) {
        const modelId = parseModelIdFromToken(cell);
        if (!modelId) continue;
        parsed.push({ id: modelId, label: modelId });
        break;
      }
      continue;
    }
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    const modelId = parseModelIdFromToken(firstToken);
    if (!modelId) continue;
    parsed.push({ id: modelId, label: modelId });
  }
  return dedupeModels(parsed);
}

function parseAgentListOutput(stdout: string): OpenCodeAgentProfile[] {
  const parsed: OpenCodeAgentProfile[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line.startsWith("-")) continue;
    const match = /^-\s+(.+?)(?:\s+\(|$)/.exec(line);
    const id = match?.[1]?.trim() ?? "";
    if (!id) continue;
    parsed.push({ id, label: id });
  }
  return dedupeAgents(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
        continue;
      }
      if (char === "\n") output += char;
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let cursor = i + 1;
      while (cursor < input.length && /\s/.test(input[cursor] ?? "")) cursor += 1;
      const next = input[cursor] ?? "";
      if (next === "}" || next === "]") continue;
    }

    output += char;
  }

  return output;
}

function parseJsonLikeObject(input: string): Record<string, unknown> | null {
  const candidates = [
    input,
    stripTrailingCommas(stripJsonComments(input)),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return asRecord(parsed);
    } catch {
      continue;
    }
  }

  return null;
}

function defaultOpenCodeConfigPaths(homeDir: string): string[] {
  return OPENCODE_CONFIG_FILENAMES.map((filename) =>
    path.join(homeDir, ".config", "opencode", filename),
  );
}

function resolveOpenCodeConfigPaths(input: {
  configPaths?: string[];
  homeDir?: string;
}): string[] {
  const homeDir = input.homeDir ?? os.homedir();
  const candidates = input.configPaths?.length
    ? input.configPaths
    : defaultOpenCodeConfigPaths(homeDir);
  return Array.from(new Set(candidates.map((entry) => path.resolve(entry))));
}

async function loadOpenCodeConfigIndex(configPaths: string[]): Promise<{
  models: AdapterModel[];
  agents: OpenCodeAgentProfile[];
  agentModels: Record<string, string>;
}> {
  const parsed: AdapterModel[] = [];
  const parsedAgents: OpenCodeAgentProfile[] = [];
  const agentModels: Record<string, string> = {};

  for (const configPath of configPaths) {
    try {
      const raw = await fsp.readFile(configPath, "utf8");
      const config = parseJsonLikeObject(raw);
      const providers = asRecord(config?.provider);
      if (providers) {
        for (const [providerId, providerConfig] of Object.entries(providers)) {
          const models = asRecord(asRecord(providerConfig)?.models);
          if (!models) continue;
          for (const modelId of Object.keys(models)) {
            const trimmedProviderId = providerId.trim();
            const trimmedModelId = modelId.trim();
            if (!trimmedProviderId || !trimmedModelId) continue;
            const id = `${trimmedProviderId}/${trimmedModelId}`;
            parsed.push({ id, label: id });
          }
        }
      }

      const agents = asRecord(config?.agent);
      if (agents) {
        for (const [agentId, agentConfig] of Object.entries(agents)) {
          const trimmedAgentId = agentId.trim();
          if (!trimmedAgentId) continue;
          parsedAgents.push({ id: trimmedAgentId, label: trimmedAgentId });
          const agentModel = asString(asRecord(agentConfig)?.model, "").trim();
          if (agentModel) {
            agentModels[trimmedAgentId] = agentModel;
          }
        }
      }

      const defaultAgent = asString(config?.default_agent, "").trim();
      if (defaultAgent) {
        parsedAgents.push({ id: defaultAgent, label: defaultAgent });
      }
    } catch {
      continue;
    }
  }

  return {
    models: sortModels(dedupeModels(parsed)),
    agents: sortAgents(dedupeAgents(parsedAgents)),
    agentModels,
  };
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(
  command: string,
  cwd: string,
  env: Record<string, string>,
  configPaths: string[],
) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${configPaths.join("\n")}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
  for (const [key, value] of agentDiscoveryCache.entries()) {
    if (value.expiresAt <= now) agentDiscoveryCache.delete(key);
  }
}

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
} = {}): Promise<AdapterModel[]> {
  const homeDir = input.homeDir ?? resolveRuntimeHomeDir();
  const command = resolveOpenCodeCommand(input.command, { homeDir });
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  let runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, HOME: homeDir }));
  runtimeEnv = (await hydrateLiteLlmApiKey(runtimeEnv, { homeDir })).env;
  const configPaths = resolveOpenCodeConfigPaths({
    configPaths: input.configPaths,
    homeDir,
  });
  const configured = await loadOpenCodeConfigIndex(configPaths);
  const configuredModels = configured.models;

  try {
    const result = await runChildProcess(
      `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["models"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (result.timedOut) {
      throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
    }
    if ((result.exitCode ?? 1) !== 0) {
      const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
      throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
    }

    const discovered = parseModelsOutput(result.stdout);
    return sortModels(dedupeModels([...discovered, ...configuredModels]));
  } catch (error) {
    if (configuredModels.length > 0) return configuredModels;
    throw error;
  }
}

export async function discoverOpenCodeAgents(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
} = {}): Promise<OpenCodeAgentProfile[]> {
  const homeDir = input.homeDir ?? resolveRuntimeHomeDir();
  const command = resolveOpenCodeCommand(input.command, { homeDir });
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  let runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, HOME: homeDir }));
  runtimeEnv = (await hydrateLiteLlmApiKey(runtimeEnv, { homeDir })).env;
  const configPaths = resolveOpenCodeConfigPaths({
    configPaths: input.configPaths,
    homeDir,
  });
  const configured = await loadOpenCodeConfigIndex(configPaths);
  const configuredAgents = configured.agents;

  try {
    const result = await runChildProcess(
      `opencode-agents-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["agent", "list"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (result.timedOut) {
      throw new Error(`\`opencode agent list\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
    }
    if ((result.exitCode ?? 1) !== 0) {
      const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
      throw new Error(
        detail ? `\`opencode agent list\` failed: ${detail}` : "`opencode agent list` failed.",
      );
    }

    const discovered = parseAgentListOutput(result.stdout);
    return sortAgents(dedupeAgents([...discovered, ...configuredAgents]));
  } catch (error) {
    if (configuredAgents.length > 0) return configuredAgents;
    throw error;
  }
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
} = {}): Promise<AdapterModel[]> {
  const homeDir = input.homeDir ?? resolveRuntimeHomeDir();
  const command = resolveOpenCodeCommand(input.command, { homeDir });
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const configPaths = resolveOpenCodeConfigPaths({
    configPaths: input.configPaths,
    homeDir,
  });
  const key = discoveryCacheKey(command, cwd, env, configPaths);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({
    command,
    cwd,
    env,
    configPaths,
    homeDir,
  });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function discoverOpenCodeAgentsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
} = {}): Promise<OpenCodeAgentProfile[]> {
  const homeDir = input.homeDir ?? resolveRuntimeHomeDir();
  const command = resolveOpenCodeCommand(input.command, { homeDir });
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const configPaths = resolveOpenCodeConfigPaths({
    configPaths: input.configPaths,
    homeDir,
  });
  const key = discoveryCacheKey(`agent-list:${command}`, cwd, env, configPaths);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = agentDiscoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.agents;

  const agents = await discoverOpenCodeAgents({
    command,
    cwd,
    env,
    configPaths,
    homeDir,
  });
  agentDiscoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, agents });
  return agents;
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    configPaths: input.configPaths,
    homeDir: input.homeDir,
  });

  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function ensureOpenCodeAgentConfiguredAndAvailable(input: {
  agent?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  configPaths?: string[];
  homeDir?: string;
}): Promise<OpenCodeAgentProfile[]> {
  const agent = asString(input.agent, "").trim();
  if (!agent) {
    throw new Error("OpenCode requires `adapterConfig.agent` to match an available agent profile.");
  }

  const agents = await discoverOpenCodeAgentsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    configPaths: input.configPaths,
    homeDir: input.homeDir,
  });

  if (agents.length === 0) {
    throw new Error("OpenCode returned no agents. Run `opencode agent list` and verify agent config.");
  }

  if (!agents.some((entry) => entry.id === agent)) {
    const sample = agents.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode agent is unavailable: ${agent}. Available agents: ${sample}${agents.length > 12 ? ", ..." : ""}`,
    );
  }

  return agents;
}

export async function resolveConfiguredOpenCodeAgentModel(input: {
  agent?: unknown;
  configPaths?: string[];
  homeDir?: string;
}): Promise<string | null> {
  const agent = asString(input.agent, "").trim();
  if (!agent) return null;
  const homeDir = input.homeDir ?? resolveRuntimeHomeDir();
  const configPaths = resolveOpenCodeConfigPaths({
    configPaths: input.configPaths,
    homeDir,
  });
  const configured = await loadOpenCodeConfigIndex(configPaths);
  const model = configured.agentModels[agent];
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export async function listOpenCodeAgents(): Promise<OpenCodeAgentProfile[]> {
  try {
    return await discoverOpenCodeAgentsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
  agentDiscoveryCache.clear();
}
