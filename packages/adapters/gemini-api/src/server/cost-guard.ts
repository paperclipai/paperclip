/**
 * Cost guard: enforces per-agent request/hour limits, per-run token limits,
 * and daily budget caps.
 *
 * State is persisted on disk in ~/.paperclip/gemini-api-cost/
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COST_DIR = path.join(os.homedir(), ".paperclip", "gemini-api-cost");

export const DEFAULT_MAX_REQUESTS_PER_AGENT_PER_HOUR = 20;
export const DEFAULT_MAX_TOKENS_PER_RUN = 100_000;
export const DEFAULT_MAX_DAILY_BUDGET_USD = 5.0;

export interface CostGuardConfig {
  maxRequestsPerAgentPerHour?: number;
  maxTokensPerRun?: number;
  maxDailyBudgetUsd?: number;
}

export type CostGuardViolation =
  | { kind: "requests_per_hour"; agentId: string; used: number; limit: number }
  | { kind: "tokens_per_run"; tokens: number; limit: number }
  | { kind: "daily_budget"; usedUsd: number; limitUsd: number };

// ---------------------------------------------------------------------------
// Per-agent hourly request tracking
// ---------------------------------------------------------------------------

interface HourlyBucket {
  agentId: string;
  hourKey: string;
  count: number;
}

function hourKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

function agentHourlyFilePath(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(COST_DIR, `hourly_${safe}.json`);
}

async function readHourlyBucket(agentId: string, key: string): Promise<HourlyBucket> {
  try {
    const raw = await fs.readFile(agentHourlyFilePath(agentId), "utf8");
    const parsed = JSON.parse(raw) as HourlyBucket;
    if (parsed.hourKey === key) return parsed;
  } catch {
    // file missing or stale
  }
  return { agentId, hourKey: key, count: 0 };
}

async function writeHourlyBucket(bucket: HourlyBucket): Promise<void> {
  await fs.mkdir(COST_DIR, { recursive: true });
  await fs.writeFile(agentHourlyFilePath(bucket.agentId), JSON.stringify(bucket, null, 2), "utf8");
}

export async function checkRequestsPerHour(
  agentId: string,
  limit: number,
  nowMs?: number,
): Promise<{ violation: CostGuardViolation | null; used: number }> {
  const now = nowMs ?? Date.now();
  const key = hourKey(now);
  const bucket = await readHourlyBucket(agentId, key);
  if (bucket.count >= limit) {
    return { violation: { kind: "requests_per_hour", agentId, used: bucket.count, limit }, used: bucket.count };
  }
  return { violation: null, used: bucket.count };
}

export async function recordRequest(agentId: string, nowMs?: number): Promise<void> {
  const now = nowMs ?? Date.now();
  const key = hourKey(now);
  const bucket = await readHourlyBucket(agentId, key);
  bucket.count += 1;
  await writeHourlyBucket(bucket);
}

// ---------------------------------------------------------------------------
// Per-run token limit (stateless — just a check against the configured limit)
// ---------------------------------------------------------------------------

export function checkTokensPerRun(
  tokens: number,
  limit: number,
): CostGuardViolation | null {
  if (tokens > limit) {
    return { kind: "tokens_per_run", tokens, limit };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Daily budget tracking
// ---------------------------------------------------------------------------

interface DailyBudget {
  dayKey: string;
  spentUsd: number;
}

function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const DAILY_FILE = path.join(COST_DIR, "daily_budget.json");

async function readDailyBudget(key: string): Promise<DailyBudget> {
  try {
    const raw = await fs.readFile(DAILY_FILE, "utf8");
    const parsed = JSON.parse(raw) as DailyBudget;
    if (parsed.dayKey === key) return parsed;
  } catch {
    // file missing or stale
  }
  return { dayKey: key, spentUsd: 0 };
}

async function writeDailyBudget(budget: DailyBudget): Promise<void> {
  await fs.mkdir(COST_DIR, { recursive: true });
  await fs.writeFile(DAILY_FILE, JSON.stringify(budget, null, 2), "utf8");
}

export async function checkDailyBudget(
  limitUsd: number,
  nowMs?: number,
): Promise<{ violation: CostGuardViolation | null; usedUsd: number }> {
  const now = nowMs ?? Date.now();
  const key = dayKey(now);
  const budget = await readDailyBudget(key);
  if (budget.spentUsd >= limitUsd) {
    return { violation: { kind: "daily_budget", usedUsd: budget.spentUsd, limitUsd }, usedUsd: budget.spentUsd };
  }
  return { violation: null, usedUsd: budget.spentUsd };
}

export async function recordSpend(costUsd: number, nowMs?: number): Promise<void> {
  const now = nowMs ?? Date.now();
  const key = dayKey(now);
  const budget = await readDailyBudget(key);
  budget.spentUsd += costUsd;
  await writeDailyBudget(budget);
}
