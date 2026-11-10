import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConnectionBlock, assertPrivateFile, parseConnectionConfig, type ConnectionConfig } from "./connection-config.js";

export const ANTIGRAVITY_JOURNEY_MODEL = "gemini-3.8-flash-low";
export interface AntigravityJourneyConfig {
  version: 1;
  setupId: string;
  hosting: "self-hosted";
  executionEnvironment: "local";
  target: Extract<ConnectionConfig["target"], { mode: "attach" }> & { companyId: string; environmentId: string };
  browser: ConnectionConfig["browser"];
  savedConnection: { id: string; name: string; ownerUserId: string };
  candidate: { platform: "darwin"; architecture: "arm64"; nativeVersion: string; profileDigest: string; nativeClosureDigest: string };
  limits: { durationMs: number; turnTimeoutMs: number; maxRuns: 2; budgetCents: number };
  retainAgent: boolean;
}

const invalid = (): never => { throw new ConnectionBlock("blocked_target", "invalid_antigravity_journey_configuration"); };
function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, any>;
}
function text(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 1024 || (pattern && !pattern.test(value))) return invalid();
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}

/** Binding references only. Candidate pins assert provenance; they do not grant admission. */
export function parseAntigravityJourneyConfig(input: unknown): AntigravityJourneyConfig {
  try {
    const v = object(input, ["version", "setupId", "hosting", "executionEnvironment", "target", "browser", "savedConnection", "candidate", "limits", "retainAgent"]);
    if (v.version !== 1 || v.hosting !== "self-hosted" || v.executionEnvironment !== "local") return invalid();
    const common = parseConnectionConfig({ target: v.target, browser: v.browser });
    if (common.target.mode !== "attach" || common.browser.freshness !== "signed-in") return invalid();
    if (new URL(common.target.baseURL).hostname !== "127.0.0.1") return invalid();
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    const connection = object(v.savedConnection, ["id", "name", "ownerUserId"]);
    const candidate = object(v.candidate, ["platform", "architecture", "nativeVersion", "profileDigest", "nativeClosureDigest"]);
    if (candidate.platform !== "darwin" || candidate.architecture !== "arm64") return invalid();
    const limits = object(v.limits, ["durationMs", "turnTimeoutMs", "maxRuns", "budgetCents"]);
    if (limits.maxRuns !== 2 || (v.retainAgent !== undefined && typeof v.retainAgent !== "boolean")) return invalid();
    const durationMs = number(limits.durationMs, 60_000, 1_800_000);
    const turnTimeoutMs = number(limits.turnTimeoutMs, 10_000, 600_000);
    if (turnTimeoutMs * 2 > durationMs) return invalid();
    return { version: 1, setupId: text(v.setupId, /^[a-z0-9-]{1,80}$/), hosting: "self-hosted", executionEnvironment: "local",
      target: { ...common.target, companyId: text(common.target.companyId, uuid), environmentId: text(common.target.environmentId, uuid) }, browser: common.browser,
      savedConnection: { id: text(connection.id, uuid), name: text(connection.name), ownerUserId: text(connection.ownerUserId) },
      candidate: { platform: "darwin", architecture: "arm64", nativeVersion: text(candidate.nativeVersion, /^\d+\.\d+\.\d+-paperclip\.\d+$/),
        profileDigest: text(candidate.profileDigest, /^sha256:[a-f0-9]{64}$/), nativeClosureDigest: text(candidate.nativeClosureDigest, /^sha256:[a-f0-9]{64}$/) },
      limits: { durationMs, turnTimeoutMs, maxRuns: 2, budgetCents: number(limits.budgetCents, 1, 1000) }, retainAgent: v.retainAgent ?? false };
  } catch { return invalid(); }
}

export async function loadAntigravityJourneyConfig(file?: string) {
  if (!file) throw new ConnectionBlock("blocked_target", "antigravity_journey_config_required");
  try {
    await assertPrivateFile(file);
    const input = JSON.parse(await readFile(file, "utf8"));
    if (input.browser?.profileDir && !path.isAbsolute(input.browser.profileDir)) input.browser.profileDir = path.resolve(path.dirname(file), input.browser.profileDir);
    return parseAntigravityJourneyConfig(input);
  } catch (error) {
    if (error instanceof ConnectionBlock) throw error;
    return invalid();
  }
}

export function antigravityConnectionConfig(config: AntigravityJourneyConfig): ConnectionConfig {
  return { target: config.target, browser: config.browser, models: {}, routes: {}, credentials: {}, budgetCents: config.limits.budgetCents,
    maxRuns: config.limits.maxRuns, turnTimeoutMs: config.limits.turnTimeoutMs, retainCompany: true };
}
