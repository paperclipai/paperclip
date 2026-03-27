import fs from "node:fs";
import path from "node:path";
import { resolveDefaultContextPath } from "../config/home.js";

const DEFAULT_CONTEXT_BASENAME = "context.json";
const DEFAULT_PROFILE = "default";

export interface ClientContextProfile {
  apiBase?: string;
  companyId?: string;
  apiKeyEnvVarName?: string;
}

export interface ClientContext {
  version: 1;
  currentProfile: string;
  profiles: Record<string, ClientContextProfile>;
}

function findContextFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".ironworks", DEFAULT_CONTEXT_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveContextPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.IRONWORKS_CONTEXT) return path.resolve(process.env.IRONWORKS_CONTEXT);
  return findContextFileFromAncestors(process.cwd()) ?? resolveDefaultContextPath();
}

export function defaultClientContext(): ClientContext {
  return {
    version: 1,
    currentProfile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: {},
    },
  };
}

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeProfile(value: unknown): ClientContextProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const profile = value as Record<string, unknown>;

  return {
    apiBase: toStringOrUndefined(profile.apiBase),
    companyId: toStringOrUndefined(profile.companyId),
    apiKeyEnvVarName: toStringOrUndefined(profile.apiKeyEnvVarName),
  };
}

function normalizeContext(raw: unknown): ClientContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultClientContext();
  }

  const record = raw as Record<string, unknown>;
  const version = record.version === 1 ? 1 : 1;
  const currentProfile = toStringOrUndefined(record.currentProfile) ?? DEFAULT_PROFILE;

  const rawProfiles = record.profiles;
  const profiles: Record<string, ClientContextProfile> = {};

  if (typeof rawProfiles === "object" && rawProfiles !== null && !Array.isArray(rawProfiles)) {
    for (const [name, profile] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (!name.trim()) continue;
      profiles[name] = normalizeProfile(profile);
    }
  }

  if (!profiles[currentProfile]) {
    profiles[currentProfile] = {};
  }

  if (Object.keys(profiles).length === 0) {
    profiles[DEFAULT_PROFILE] = {};
  }

  return {
    version,
    currentProfile,
    profiles,
  };
}

export function readContext(contextPath?: string): ClientContext {
  const filePath = resolveContextPath(contextPath);
  if (!fs.existsSync(filePath)) {
    return defaultClientContext();
  }

  const raw = parseJson(filePath);
  return normalizeContext(raw);
}

export function writeContext(context: ClientContext, contextPath?: string): void {
  const filePath = resolveContextPath(contextPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const normalized = normalizeContext(context);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
}

export function upsertProfile(
  profileName: string,
  patch: Partial<ClientContextProfile>,
  contextPath?: string,
): ClientContext {
  const context = readContext(contextPath);
  const existing = context.profiles[profileName] ?? {};
  const merged: ClientContextProfile = {
    ...existing,
    ...patch,
  };

  if (patch.apiBase !== undefined && patch.apiBase.trim().length === 0) {
    delete merged.apiBase;
  }
  if (patch.companyId !== undefined && patch.companyId.trim().length === 0) {
    delete merged.companyId;
  }
  if (patch.apiKeyEnvVarName !== undefined && patch.apiKeyEnvVarName.trim().length === 0) {
    delete merged.apiKeyEnvVarName;
  }

  context.profiles[profileName] = merged;
  context.currentProfile = context.currentProfile || profileName;
  writeContext(context, contextPath);
  return context;
}

export function setCurrentProfile(profileName: string, contextPath?: string): ClientContext {
  const context = readContext(contextPath);
  if (!context.profiles[profileName]) {
    context.profiles[profileName] = {};
  }
  context.currentProfile = profileName;
  writeContext(context, contextPath);
  return context;
}

export function resolveProfile(
  context: ClientContext,
  profileName?: string,
): { name: string; profile: ClientContextProfile } {
  const name = profileName?.trim() || context.currentProfile || DEFAULT_PROFILE;
  const profile = context.profiles[name] ?? {};
  return { name, profile };
}
