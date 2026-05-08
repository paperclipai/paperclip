import type { Db } from "@paperclipai/db";
import { bettingBankrollSnapshots } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const DEFAULT_DAILY_LIMIT_PCT = 0.05;
const DEFAULT_SESSION_LIMIT_PCT = 0.10;
const DEFAULT_TIME_ZONE = "Europe/Bucharest";
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const alertCooldowns = new Map<string, number>();

type StopLossTrigger = "daily" | "session";

export interface StopLossPreflightInput {
  companyId: string;
  currentBalance?: number | null;
  currency?: string | null;
  at?: Date | string | null;
  sessionStartedAt?: Date | string | null;
  dailyLimitPct?: number;
  sessionLimitPct?: number;
  timeZone?: string;
  notifyOnTrigger?: boolean;
  source?: string | null;
}

export interface StopLossPreflightResult {
  allowed: boolean;
  triggers: StopLossTrigger[];
  currentBalance: number | null;
  currency: string;
  evaluatedAt: string;
  timeZone: string;
  daily: {
    baselineBalance: number | null;
    baselineAt: string | null;
    floorBalance: number | null;
    lossAmount: number | null;
    lossPct: number | null;
    limitPct: number;
  };
  session: {
    baselineBalance: number | null;
    baselineAt: string | null;
    floorBalance: number | null;
    lossAmount: number | null;
    lossPct: number | null;
    limitPct: number;
  };
  reason: string | null;
}

type SnapshotRow = {
  balance: number;
  currency: string;
  snapshotAt: Date;
};

function parseDate(value: Date | string | null | undefined, fallback: Date) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function formatDayKey(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function calculateLoss(baselineBalance: number | null, currentBalance: number | null) {
  if (baselineBalance == null || currentBalance == null || baselineBalance <= 0) {
    return { lossAmount: null, lossPct: null, floorBalance: null };
  }
  const lossAmountRaw = baselineBalance - currentBalance;
  const lossAmount = lossAmountRaw > 0 ? lossAmountRaw : 0;
  const lossPct = lossAmount / baselineBalance;
  return {
    lossAmount,
    lossPct,
    floorBalance: baselineBalance,
  };
}

function pickDailyBaseline(snapshots: SnapshotRow[], evaluatedAt: Date, timeZone: string) {
  const evaluatedDayKey = formatDayKey(evaluatedAt, timeZone);
  const sameDay = snapshots.filter((snapshot) => formatDayKey(snapshot.snapshotAt, timeZone) === evaluatedDayKey);
  if (sameDay.length > 0) return sameDay[0] ?? null;

  const previous = snapshots.filter((snapshot) => snapshot.snapshotAt.getTime() <= evaluatedAt.getTime());
  return previous.at(-1) ?? null;
}

function pickSessionBaseline(snapshots: SnapshotRow[], evaluatedAt: Date, sessionStartedAt: Date | null) {
  if (!sessionStartedAt) return snapshots[0] ?? null;

  const beforeOrAtSessionStart = snapshots.filter((snapshot) => snapshot.snapshotAt.getTime() <= sessionStartedAt.getTime());
  if (beforeOrAtSessionStart.length > 0) return beforeOrAtSessionStart.at(-1) ?? null;

  const afterSessionStart = snapshots.filter(
    (snapshot) =>
      snapshot.snapshotAt.getTime() >= sessionStartedAt.getTime() &&
      snapshot.snapshotAt.getTime() <= evaluatedAt.getTime(),
  );
  return afterSessionStart[0] ?? null;
}

function buildAlertKey(companyId: string, triggers: StopLossTrigger[], dayKey: string) {
  return `betting_stop_loss:${companyId}:${dayKey}:${triggers.sort().join(",")}`;
}

function maybeSendTelegramAlert(result: StopLossPreflightResult, companyId: string, source: string | null) {
  if (result.allowed || result.currentBalance == null || result.triggers.length === 0) return;

  const alertKey = buildAlertKey(companyId, result.triggers, formatDayKey(new Date(result.evaluatedAt), result.timeZone));
  const lastSentAt = alertCooldowns.get(alertKey) ?? 0;
  if (Date.now() - lastSentAt < ALERT_COOLDOWN_MS) return;
  alertCooldowns.set(alertKey, Date.now());

  const bot = (globalThis as Record<string, unknown>).__telegramBot as
    | { send: (text: string) => Promise<void> }
    | undefined;
  if (!bot) return;

  const triggerLabel =
    result.triggers.length === 2
      ? "daily + session"
      : result.triggers[0] === "daily"
        ? "daily"
        : "session";
  const dailyFloor =
    typeof result.daily.floorBalance === "number" ? result.daily.floorBalance.toFixed(2) : "n/a";
  const sessionFloor =
    typeof result.session.floorBalance === "number" ? result.session.floorBalance.toFixed(2) : "n/a";

  const message =
    `🛑 <b>Betting stop-loss triggered</b>\n` +
    `Trigger: ${triggerLabel}\n` +
    `Current bankroll: ${result.currentBalance.toFixed(2)} ${result.currency}\n` +
    `Daily floor: ${dailyFloor} ${result.currency}\n` +
    `Session floor: ${sessionFloor} ${result.currency}\n` +
    `Time zone: ${result.timeZone}\n` +
    (source ? `Source: ${source}\n` : "");

  void bot.send(message).catch((err) => {
    logger.warn({ err, companyId }, "betting stop-loss: telegram alert failed");
  });
}

export function bettingStopLossService(db: Db) {
  return {
    preflight: async (input: StopLossPreflightInput): Promise<StopLossPreflightResult> => {
      const evaluatedAt = parseDate(input.at, new Date());
      const sessionStartedAt = input.sessionStartedAt ? parseDate(input.sessionStartedAt, evaluatedAt) : null;
      const timeZone = input.timeZone?.trim() || DEFAULT_TIME_ZONE;
      const dailyLimitPct = input.dailyLimitPct ?? DEFAULT_DAILY_LIMIT_PCT;
      const sessionLimitPct = input.sessionLimitPct ?? DEFAULT_SESSION_LIMIT_PCT;

      const snapshots = await db
        .select({
          balance: bettingBankrollSnapshots.balance,
          currency: bettingBankrollSnapshots.currency,
          snapshotAt: bettingBankrollSnapshots.snapshotAt,
        })
        .from(bettingBankrollSnapshots)
        .where(eq(bettingBankrollSnapshots.companyId, input.companyId))
        .orderBy(asc(bettingBankrollSnapshots.snapshotAt));

      const normalizedSnapshots = snapshots.map((snapshot) => ({
        balance: snapshot.balance,
        currency: snapshot.currency,
        snapshotAt: snapshot.snapshotAt,
      }));
      const latestSnapshot = normalizedSnapshots.at(-1) ?? null;
      const currentBalance = input.currentBalance ?? latestSnapshot?.balance ?? null;
      const currency = input.currency?.trim() || latestSnapshot?.currency || "RON";

      if (currentBalance == null) {
        return {
          allowed: false,
          triggers: [],
          currentBalance: null,
          currency,
          evaluatedAt: evaluatedAt.toISOString(),
          timeZone,
          daily: {
            baselineBalance: null,
            baselineAt: null,
            floorBalance: null,
            lossAmount: null,
            lossPct: null,
            limitPct: dailyLimitPct,
          },
          session: {
            baselineBalance: null,
            baselineAt: null,
            floorBalance: null,
            lossAmount: null,
            lossPct: null,
            limitPct: sessionLimitPct,
          },
          reason: "Missing bankroll baseline; refusing bet placement until bankroll snapshots exist.",
        };
      }

      const dailyBaseline = pickDailyBaseline(normalizedSnapshots, evaluatedAt, timeZone);
      const sessionBaseline = pickSessionBaseline(normalizedSnapshots, evaluatedAt, sessionStartedAt);

      const dailyLoss = calculateLoss(dailyBaseline?.balance ?? null, currentBalance);
      const sessionLoss = calculateLoss(sessionBaseline?.balance ?? null, currentBalance);
      const dailyFloorBalance =
        dailyBaseline?.balance != null ? dailyBaseline.balance * (1 - dailyLimitPct) : null;
      const sessionFloorBalance =
        sessionBaseline?.balance != null ? sessionBaseline.balance * (1 - sessionLimitPct) : null;

      const triggers: StopLossTrigger[] = [];
      if ((dailyLoss.lossPct ?? 0) >= dailyLimitPct) triggers.push("daily");
      if ((sessionLoss.lossPct ?? 0) >= sessionLimitPct) triggers.push("session");

      const result: StopLossPreflightResult = {
        allowed: triggers.length === 0,
        triggers,
        currentBalance,
        currency,
        evaluatedAt: evaluatedAt.toISOString(),
        timeZone,
        daily: {
          baselineBalance: dailyBaseline?.balance ?? null,
          baselineAt: dailyBaseline?.snapshotAt?.toISOString() ?? null,
          floorBalance: dailyFloorBalance,
          lossAmount: dailyLoss.lossAmount,
          lossPct: dailyLoss.lossPct,
          limitPct: dailyLimitPct,
        },
        session: {
          baselineBalance: sessionBaseline?.balance ?? null,
          baselineAt: sessionBaseline?.snapshotAt?.toISOString() ?? null,
          floorBalance: sessionFloorBalance,
          lossAmount: sessionLoss.lossAmount,
          lossPct: sessionLoss.lossPct,
          limitPct: sessionLimitPct,
        },
        reason:
          triggers.length === 0
            ? null
            : `Hard stop-loss triggered (${triggers.join(", ")}); executor must refuse bet placement.`,
      };

      if (input.notifyOnTrigger !== false) {
        maybeSendTelegramAlert(result, input.companyId, input.source ?? null);
      }

      return result;
    },
  };
}

