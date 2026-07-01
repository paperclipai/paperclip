import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";

export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV = "PAPERCLIP_AGENT_DEFAULT_MAX_CONCURRENT_RUNS";
export const AGENT_MAX_CONCURRENT_RUNS_MIN = 1;
export const AGENT_MAX_CONCURRENT_RUNS_MAX = 50;

export function normalizeAgentMaxConcurrentRuns(value: unknown, fallback = AGENT_DEFAULT_MAX_CONCURRENT_RUNS) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value.trim())
      : fallback;
  const floored = Math.floor(parsed);
  const normalized = Number.isFinite(floored) ? floored : fallback;
  return Math.max(AGENT_MAX_CONCURRENT_RUNS_MIN, Math.min(AGENT_MAX_CONCURRENT_RUNS_MAX, normalized));
}

export function resolveAgentDefaultMaxConcurrentRuns(env: NodeJS.ProcessEnv = process.env) {
  return normalizeAgentMaxConcurrentRuns(env[AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]);
}
