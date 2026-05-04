import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { parseObject, asNumber } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";

const TRACKED_ADAPTERS = ["claude_local", "codex_local"] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_FILE_VERSION = 1;
const DEFAULT_USAGE_FILE = path.join(os.homedir(), ".paperclip", "usage.json");

const THRESHOLDS = [
  { key: "p1_70", severity: "P1", percent: 70, hardStop: false },
  { key: "p0_85", severity: "P0", percent: 85, hardStop: false },
  { key: "p0_hard_stop_95", severity: "P0", percent: 95, hardStop: true },
] as const;

type TrackedAdapter = typeof TRACKED_ADAPTERS[number];
type ThresholdKey = typeof THRESHOLDS[number]["key"];

export interface WeeklyUsageServiceOptions {
  usageFilePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface WeeklyUsageThresholdState {
  fired: boolean;
  firedAt: string | null;
  lastPercent: number;
}

export interface WeeklyUsageAdapterState {
  adapterType: TrackedAdapter;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runCount: number;
  runIds: string[];
  cursor: {
    includedRunIds: string[];
    latestRunFinishedAt: string | null;
  };
  lastRunFinishedAt: string | null;
  cap: {
    weeklyTotalTokens: number;
    source: string;
    note: string;
  };
  thresholds: Record<ThresholdKey, WeeklyUsageThresholdState>;
  hardStopped: boolean;
}

export interface WeeklyUsageFile {
  version: number;
  generatedAt: string;
  lastUpdatedAt: string;
  window: {
    kind: "rolling_7d";
    start: string;
    end: string;
  };
  adapters: Record<TrackedAdapter, WeeklyUsageAdapterState>;
}

type RunRow = {
  id: string;
  adapterType: string;
  finishedAt: Date | null;
  createdAt: Date;
  usageJson: Record<string, unknown> | null;
};

function cleanEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function adapterEnvKey(adapterType: TrackedAdapter) {
  return `PAPERCLIP_WEEKLY_USAGE_CAP_${adapterType.toUpperCase()}_TOKENS`;
}

function readCap(adapterType: TrackedAdapter, env: NodeJS.ProcessEnv) {
  const raw = env[adapterEnvKey(adapterType)];
  const parsed = Number(raw);
  const weeklyTotalTokens = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return {
    weeklyTotalTokens,
    source: raw ? adapterEnvKey(adapterType) : "unset",
    note: [
      "As of 2026-05-03, Anthropic and OpenAI publish plan/message limits but not exact rolling weekly token caps for Claude Code or Codex local subscription usage.",
      "Set this cap from the provider UI/plan allowance or smoke tests via PAPERCLIP_WEEKLY_USAGE_CAP_CLAUDE_LOCAL_TOKENS and PAPERCLIP_WEEKLY_USAGE_CAP_CODEX_LOCAL_TOKENS.",
    ].join(" "),
  };
}

function readToken(value: unknown) {
  return Math.max(0, Math.floor(asNumber(value, 0)));
}

function extractUsage(usageJson: unknown) {
  const usage = parseObject(usageJson);
  const inputTokens = readToken(usage.rawInputTokens ?? usage.inputTokens ?? usage.input_tokens);
  const cachedInputTokens = readToken(
    usage.rawCachedInputTokens ??
      usage.cachedInputTokens ??
      usage.cached_input_tokens ??
      usage.cache_read_input_tokens,
  );
  const outputTokens = readToken(usage.rawOutputTokens ?? usage.outputTokens ?? usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens,
  };
}

async function readExistingUsage(filePath: string): Promise<WeeklyUsageFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WeeklyUsageFile;
    return parsed && parsed.version === USAGE_FILE_VERSION ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn({ err, filePath }, "failed to read weekly usage file; starting from database snapshot");
    return null;
  }
}

async function writeUsageFileAtomically(filePath: string, data: WeeklyUsageFile) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

function defaultThresholds(percent: number): Record<ThresholdKey, WeeklyUsageThresholdState> {
  return {
    p1_70: { fired: false, firedAt: null, lastPercent: percent },
    p0_85: { fired: false, firedAt: null, lastPercent: percent },
    p0_hard_stop_95: { fired: false, firedAt: null, lastPercent: percent },
  };
}

function isTrackedAdapter(adapterType: string): adapterType is TrackedAdapter {
  return (TRACKED_ADAPTERS as readonly string[]).includes(adapterType);
}

function isCriticalRecoveryAgent(agent: { role: string | null; name: string | null; title: string | null }) {
  const haystack = [agent.role, agent.name, agent.title].filter(Boolean).join(" ").toLowerCase();
  return /\bceo\b/.test(haystack) || /\bcto\b/.test(haystack) || haystack.includes("chief technology");
}

function formatUsageAlert(input: {
  adapter: WeeklyUsageAdapterState;
  threshold: typeof THRESHOLDS[number];
  percent: number;
}) {
  const hardStop = input.threshold.hardStop ? " hard-stop" : "";
  return [
    `${input.threshold.severity}${hardStop}: ${input.adapter.adapterType} weekly usage ${input.percent.toFixed(1)}%`,
    `Tokens: ${input.adapter.totalTokens.toLocaleString()} / ${input.adapter.cap.weeklyTotalTokens.toLocaleString()}`,
    `Input: ${input.adapter.inputTokens.toLocaleString()} (+${input.adapter.cachedInputTokens.toLocaleString()} cached), output: ${input.adapter.outputTokens.toLocaleString()}`,
    `Runs in rolling 7d: ${input.adapter.runCount}`,
    input.threshold.hardStop
      ? "Non-critical agent wakes for this adapter are blocked until usage drops below 95% or the cap is raised."
      : "Monitor burn rate and raise the cap or pause low-priority work before the hard-stop threshold.",
  ].join("\n");
}

async function sendTelegram(input: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  message: string;
}) {
  const telegramBotToken = cleanEnv(input.env.PAPERCLIP_P0_TELEGRAM_BOT_TOKEN);
  const telegramChatId = cleanEnv(input.env.PAPERCLIP_P0_TELEGRAM_CHAT_ID);
  if (!telegramBotToken || !telegramChatId) return false;
  await input.fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(telegramBotToken)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: input.message,
      disable_web_page_preview: true,
    }),
  });
  return true;
}

export function weeklyUsageService(db: Db, options: WeeklyUsageServiceOptions = {}) {
  const usageFilePath = options.usageFilePath ?? options.env?.PAPERCLIP_USAGE_FILE ?? DEFAULT_USAGE_FILE;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? fetch;

  async function buildSnapshot(existing: WeeklyUsageFile | null): Promise<WeeklyUsageFile> {
    const end = now();
    const start = new Date(end.getTime() - WEEK_MS);
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        adapterType: agents.adapterType,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          gte(heartbeatRuns.finishedAt, start),
          lte(heartbeatRuns.finishedAt, end),
          isNotNull(heartbeatRuns.usageJson),
          inArray(agents.adapterType, [...TRACKED_ADAPTERS]),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt)) as RunRow[];

    const adapters = Object.fromEntries(
      TRACKED_ADAPTERS.map((adapterType) => {
        const cap = readCap(adapterType, env);
        const adapterRows = rows.filter((row) => {
          if (row.adapterType !== adapterType || !row.finishedAt) return false;
          const finishedAt = row.finishedAt.getTime();
          return finishedAt >= start.getTime() && finishedAt <= end.getTime();
        });
        const totals = adapterRows.reduce(
          (acc, row) => {
            const usage = extractUsage(row.usageJson);
            acc.inputTokens += usage.inputTokens;
            acc.cachedInputTokens += usage.cachedInputTokens;
            acc.outputTokens += usage.outputTokens;
            acc.totalTokens += usage.totalTokens;
            return acc;
          },
          { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
        );
        const percent = cap.weeklyTotalTokens > 0 ? (totals.totalTokens / cap.weeklyTotalTokens) * 100 : 0;
        const previous = existing?.adapters?.[adapterType];
        const thresholds = defaultThresholds(percent);
        for (const threshold of THRESHOLDS) {
          const previousState = previous?.thresholds?.[threshold.key];
          thresholds[threshold.key] = percent >= threshold.percent && previousState?.fired
            ? { ...previousState, lastPercent: percent }
            : { fired: false, firedAt: null, lastPercent: percent };
        }
        return [adapterType, {
          adapterType,
          ...totals,
          runCount: adapterRows.length,
          runIds: adapterRows.map((row) => row.id),
          cursor: {
            includedRunIds: adapterRows.map((row) => row.id),
            latestRunFinishedAt: adapterRows[0]?.finishedAt?.toISOString() ?? null,
          },
          lastRunFinishedAt: adapterRows[0]?.finishedAt?.toISOString() ?? null,
          cap,
          thresholds,
          hardStopped: cap.weeklyTotalTokens > 0 && percent >= 95,
        }];
      }),
    ) as Record<TrackedAdapter, WeeklyUsageAdapterState>;

    return {
      version: USAGE_FILE_VERSION,
      generatedAt: end.toISOString(),
      lastUpdatedAt: end.toISOString(),
      window: {
        kind: "rolling_7d",
        start: start.toISOString(),
        end: end.toISOString(),
      },
      adapters,
    };
  }

  async function updateFromHeartbeatRuns() {
    const existing = await readExistingUsage(usageFilePath);
    const snapshot = await buildSnapshot(existing);
    for (const adapter of Object.values(snapshot.adapters)) {
      if (adapter.cap.weeklyTotalTokens <= 0) continue;
      const percent = (adapter.totalTokens / adapter.cap.weeklyTotalTokens) * 100;
      for (const threshold of THRESHOLDS) {
        if (percent < threshold.percent || adapter.thresholds[threshold.key].fired) continue;
        try {
          const delivered = await sendTelegram({
            env,
            fetchImpl,
            message: formatUsageAlert({ adapter, threshold, percent }),
          });
          if (!delivered) continue;
          adapter.thresholds[threshold.key] = {
            fired: true,
            firedAt: snapshot.generatedAt,
            lastPercent: percent,
          };
        } catch (err) {
          logger.warn({ err, adapterType: adapter.adapterType, threshold: threshold.key }, "weekly usage alert failed");
        }
      }
    }
    await writeUsageFileAtomically(usageFilePath, snapshot);
    return snapshot;
  }

  async function getInvocationBlock(companyId: string, agentId: string) {
    const agent = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        role: agents.role,
        name: agents.name,
        title: agents.title,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) return null;
    if (!isTrackedAdapter(agent.adapterType) || isCriticalRecoveryAgent(agent)) return null;

    const usage = await readExistingUsage(usageFilePath);
    const adapter = usage?.adapters?.[agent.adapterType];
    if (!adapter?.hardStopped) return null;
    return {
      scopeType: "adapter_type" as const,
      scopeId: agent.adapterType,
      scopeName: `Adapter type ${agent.adapterType}`,
      reason: `Agent cannot start because ${agent.adapterType} rolling 7-day usage is at ${adapter.thresholds.p0_hard_stop_95.lastPercent.toFixed(1)}% of the configured weekly token cap.`,
    };
  }

  return {
    updateFromHeartbeatRuns,
    getInvocationBlock,
  };
}
