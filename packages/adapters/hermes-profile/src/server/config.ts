import * as os from "node:os";
import * as path from "node:path";

export interface HermesProfileAdapterConfig {
  profile: string;
  allowedProfiles?: string[];
  timeoutSec?: number;
  graceSec?: number;
  persistSession?: boolean;
  cwd?: string;
  paperclipApiUrl?: string;
  promptTemplate?: string;
  quiet?: boolean;
  yolo?: boolean;
  source?: string;
  toolsets?: string;
  enabledToolsets?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
}

const PROFILE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const DEFAULT_ALLOWED_PROFILES = ["aster", "cleo", "devin", "fiona", "stella"];

function objectRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function cfgString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function cfgNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function cfgNonNegativeNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function cfgStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function cfgEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function profileHome(profile: string): string {
  return path.join(os.homedir(), ".hermes", "profiles", profile);
}

export function profileWrapperPath(profile: string): string {
  return path.join(profileHome(profile), "bin", "hermes-profile-wrapper.sh");
}

export function parseHermesProfileConfig(raw: unknown): HermesProfileAdapterConfig {
  const value = objectRecord(raw);
  const profile = cfgString(value.profile);
  if (!profile || !PROFILE_RE.test(profile)) {
    throw new Error("Invalid hermes_profile adapterConfig.profile");
  }

  const allowedProfiles = cfgStringArray(value.allowedProfiles) ?? DEFAULT_ALLOWED_PROFILES;
  if (!allowedProfiles.includes(profile)) {
    throw new Error(`Profile ${profile} is not allowlisted for hermes_profile`);
  }

  return {
    profile,
    allowedProfiles,
    timeoutSec: cfgNonNegativeNumber(value.timeoutSec, 0, 86400),
    graceSec: cfgNumber(value.graceSec, 10, 1, 120),
    persistSession: typeof value.persistSession === "boolean" ? value.persistSession : true,
    cwd: cfgString(value.cwd),
    paperclipApiUrl: cfgString(value.paperclipApiUrl),
    promptTemplate: cfgString(value.promptTemplate),
    quiet: typeof value.quiet === "boolean" ? value.quiet : true,
    yolo: typeof value.yolo === "boolean" ? value.yolo : true,
    source: cfgString(value.source) ?? "paperclip",
    toolsets: cfgString(value.toolsets),
    enabledToolsets: cfgStringArray(value.enabledToolsets),
    extraArgs: cfgStringArray(value.extraArgs),
    env: cfgEnv(value.env),
  };
}

export function parseAdapterConfigFromContext(ctx: {
  agent?: { adapterConfig?: unknown };
  config?: unknown;
}): HermesProfileAdapterConfig {
  return parseHermesProfileConfig(ctx.agent?.adapterConfig ?? ctx.config);
}
