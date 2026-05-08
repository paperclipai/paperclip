import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  bettingBankrollSnapshots,
  bettingMatches,
  bettingPlacedBets,
  bettingPredictions,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type {
  BettingOpsDashboardAgentMetric,
  BettingOpsDashboardDailyPerf,
  BettingOpsDashboardData,
  BettingOpsDashboardDistributionPoint,
  BettingOpsDashboardEntry,
  BettingOpsDashboardMatch,
  BettingOpsDashboardSeriesCollection,
  BettingOpsDashboardSeriesPoint,
  BettingOpsDashboardShortcutInfo,
  BettingOpsDashboardShortcutInstallResult,
  BettingOpsDashboardSimBet,
  BettingOpsDashboardSimulation,
  BettingOpsDashboardSlip,
  BettingOpsDashboardSlipLeg,
} from "@paperclipai/shared";
import { resolveDefaultAgentWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

type ParsedReportArtifact = {
  entries: BettingOpsDashboardEntry[];
  slips: BettingOpsDashboardSlip[];
};

function parsePercentValue(raw: string): number | null {
  const match = raw.match(/(-?\d+(?:\.\d+)?)\s*%/);
  return match ? Number.parseFloat(match[1] ?? "") : null;
}

function parseDecimalValue(raw: string): number | null {
  const match = raw.match(/(-?\d+(?:\.\d+)?)/);
  return match ? Number.parseFloat(match[1] ?? "") : null;
}

function parseIsoDateOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function pushDistribution(
  map: Map<string, number>,
  key: string | null | undefined,
  increment = 1,
) {
  const normalized = key?.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + increment);
}

function mapToDistribution(
  input: Map<string, number>,
): BettingOpsDashboardDistributionPoint[] {
  return [...input.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, value]) => ({ label, value }));
}

function groupSeriesPoints(
  points: Array<{ timestamp: Date; balance: number }>,
  mode: "day" | "week" | "month",
): BettingOpsDashboardSeriesPoint[] {
  const grouped = new Map<string, { timestamp: Date; balance: number; pnl: number }>();
  const baseline = points[0]?.balance ?? 0;

  for (const point of points) {
    const stamp = point.timestamp;
    const key =
      mode === "day"
        ? stamp.toISOString().slice(0, 10)
        : mode === "week"
          ? `${stamp.getUTCFullYear()}-W${Math.ceil(
            ((Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate()) -
              Date.UTC(stamp.getUTCFullYear(), 0, 1)) /
              86_400_000 +
              new Date(Date.UTC(stamp.getUTCFullYear(), 0, 1)).getUTCDay() +
              1) /
              7,
          )}`
          : `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, "0")}`;
    grouped.set(key, {
      timestamp: stamp,
      balance: point.balance,
      pnl: point.balance - baseline,
    });
  }

  return [...grouped.entries()]
    .map(([label, value]) => ({
      label,
      timestamp: value.timestamp.toISOString(),
      balance: value.balance,
      pnl: value.pnl,
    }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function extractLineValue(lines: string[], prefix: string): string | null {
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line ? normalizeLabel(line.slice(prefix.length)) : null;
}

function parseSlipLegs(lines: string[]): BettingOpsDashboardSlipLeg[] {
  const legs: BettingOpsDashboardSlipLeg[] = [];
  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const value = normalizeLabel(line.slice(2));
    if (
      value.startsWith("Approx combined") ||
      value.startsWith("Quality note:") ||
      value.startsWith("Reason:") ||
      value.startsWith("Leg probability:") ||
      value.startsWith("Decimal odds:")
    ) {
      continue;
    }
    if (value.includes(" + ")) {
      for (const part of value.split(/\s+\+\s+/)) {
        const pick = normalizeLabel(part);
        if (!pick) continue;
        legs.push({ pick, matchLabel: null, confidencePercent: null });
      }
      continue;
    }
    legs.push({ pick: value, matchLabel: null, confidencePercent: null });
  }
  return legs;
}

function parseBettingReportArtifact(input: {
  filePath: string;
  content: string;
  createdAt: Date;
}): ParsedReportArtifact {
  const lines = input.content.split(/\r?\n/);
  const entries: BettingOpsDashboardEntry[] = [];
  const slips: BettingOpsDashboardSlip[] = [];
  const taskMatch = input.content.match(/^#\s+(BET-\d+)/m);
  const taskIdentifier = taskMatch?.[1] ?? null;
  const source = path.basename(input.filePath);

  const rankedSinglesIndex = lines.findIndex((line) => line.trim() === "## Ranked Singles");
  if (rankedSinglesIndex >= 0) {
    for (let index = rankedSinglesIndex + 1; index < lines.length; index += 1) {
      const header = lines[index]?.trim() ?? "";
      const headerMatch = header.match(/^(\d+)\.\s+(.+)$/);
      if (!headerMatch) {
        if (header.startsWith("## ")) break;
        continue;
      }

      const blockLines: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const current = lines[cursor]?.trim() ?? "";
        if (/^\d+\.\s+/.test(current) || current.startsWith("## ")) break;
        if (current) blockLines.push(current);
        cursor += 1;
      }
      index = cursor - 1;

      const startsAt = extractLineValue(blockLines, "- Start: ");
      const confidencePercent = parsePercentValue(
        extractLineValue(blockLines, "- Model probability: ") ?? "",
      );
      const edgePercent = parsePercentValue(extractLineValue(blockLines, "- Edge: ") ?? "");
      const oddsRaw = extractLineValue(blockLines, "- Book odds: ");
      const decimalInParens = oddsRaw?.match(/\((\d+(?:\.\d+)?)\)/)?.[1] ?? null;

      entries.push({
        id: `${source}:single:${headerMatch[1]}`,
        kind: "simulated",
        status: "simulat",
        matchLabel: normalizeLabel(headerMatch[2] ?? ""),
        sport: null,
        league: extractLineValue(blockLines, "- League: "),
        startsAt: parseIsoDateOrNull(startsAt),
        settledAt: null,
        pick: extractLineValue(blockLines, "- Pick: ") ?? "N/A",
        market: extractLineValue(blockLines, "- Market: "),
        confidencePercent,
        edgePercent,
        odds: decimalInParens ? Number.parseFloat(decimalInParens) : parseDecimalValue(oddsRaw ?? ""),
        targetOdds: parseDecimalValue(extractLineValue(blockLines, "- Fair odds: ") ?? ""),
        stake: null,
        bookmaker: null,
        source,
        agentName: null,
        taskIdentifier,
        reasoning: extractLineValue(blockLines, "- Rationale: "),
        profitLoss: null,
        currency: null,
        createdAt: input.createdAt.toISOString(),
      });
    }
  }

  const slipSectionIndex = lines.findIndex(
    (line) =>
      line.trim() === "## Two-Leg Simulation Slips" || line.trim() === "## The 5 Slips",
  );
  if (slipSectionIndex >= 0) {
    for (let index = slipSectionIndex + 1; index < lines.length; index += 1) {
      const header = lines[index]?.trim() ?? "";
      const headerMatch = header.match(/^(\d+)\.\s+(.+)$/);
      if (!headerMatch) {
        if (header.startsWith("## ")) break;
        continue;
      }

      const blockLines: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const current = lines[cursor]?.trim() ?? "";
        if (/^\d+\.\s+/.test(current) || current.startsWith("## ")) break;
        if (current) blockLines.push(current);
        cursor += 1;
      }
      index = cursor - 1;

      slips.push({
        id: `${source}:slip:${headerMatch[1]}`,
        title: normalizeLabel(headerMatch[2] ?? ""),
        status: "simulat",
        source,
        taskIdentifier,
        createdAt: input.createdAt.toISOString(),
        combinedProbabilityPercent:
          parsePercentValue(extractLineValue(blockLines, "- Approx combined hit probability: ") ?? "") ??
          parsePercentValue(extractLineValue(blockLines, "- Leg probability: ") ?? ""),
        combinedOdds:
          parseDecimalValue(extractLineValue(blockLines, "- Approx combined decimal odds: ") ?? "") ??
          parseDecimalValue(extractLineValue(blockLines, "- Decimal odds: ") ?? ""),
        note:
          extractLineValue(blockLines, "- Reason: ") ??
          extractLineValue(blockLines, "- Quality note: "),
        legs: parseSlipLegs(blockLines),
      });
    }
  }

  return { entries, slips };
}

async function collectReportArtifacts(agentIds: string[]): Promise<ParsedReportArtifact> {
  const aggregated: ParsedReportArtifact = { entries: [], slips: [] };
  const seenFiles = new Set<string>();

  for (const agentId of agentIds) {
    const reportsDir = path.join(resolveDefaultAgentWorkspaceDir(agentId), "reports");
    const reportEntries = await fs.readdir(reportsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of reportEntries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const filePath = path.join(reportsDir, entry.name);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const stats = await fs.stat(filePath).catch(() => null);
      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      if (!stats || !content) continue;
      const parsed = parseBettingReportArtifact({
        filePath,
        content,
        createdAt: stats.mtime,
      });
      aggregated.entries.push(...parsed.entries);
      aggregated.slips.push(...parsed.slips);
    }
  }

  aggregated.entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  aggregated.slips.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return aggregated;
}

function buildShortcutInfo(targetUrl: string): BettingOpsDashboardShortcutInfo {
  const desktopPath = path.join(resolveDesktopDir(), "Paperclip Betting Ops Dashboard.url");
  return {
    targetUrl,
    desktopPath,
    installed: false,
  };
}

function resolveDesktopDir(): string {
  const candidates = [
    process.env.DESKTOP,
    process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : null,
    process.env.OneDriveConsumer ? path.join(process.env.OneDriveConsumer, "Desktop") : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : null,
    path.join(os.homedir(), "Desktop"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (requirePathExists(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return path.join(os.homedir(), "Desktop");
}

function requirePathExists(candidate: string): boolean {
  return !!candidate && existsSync(candidate);
}

type FilesBankrollDay = { date: string; profit_loss: number; bets: number; opening: number; closing: number };
type FilesBankroll = {
  current_bankroll: number;
  today_date?: string;
  today_opening_bankroll?: number;
  today_profit_loss?: number;
  today_bets_count?: number;
  total_lifetime_profit?: number;
  daily_history?: FilesBankrollDay[];
};
type FilesBetSelection = {
  home_team: string;
  away_team: string;
  sport: string;
  league: string;
  selection: string;
  odds: number;
  estimated_probability: number;
  edge: number;
  reasoning?: string;
};
type FilesBetEntry = {
  id: string;
  bet_type: string;
  selections: FilesBetSelection[];
  stake: number;
  total_odds: number;
  status: string;
  placed_at: string;
  settled_at?: string;
  profit_loss: number;
};

async function findBettingSystemDir(companyId: string): Promise<string | null> {
  const companyProjectsDir = path.join(resolvePaperclipInstanceRoot(), "projects", companyId);
  const projectEntries = await fs.readdir(companyProjectsDir, { withFileTypes: true }).catch(() => []);
  for (const pe of projectEntries) {
    if (!pe.isDirectory()) continue;
    const repoEntries = await fs
      .readdir(path.join(companyProjectsDir, pe.name), { withFileTypes: true })
      .catch(() => []);
    for (const re of repoEntries) {
      if (!re.isDirectory()) continue;
      const candidate = path.join(companyProjectsDir, pe.name, re.name, "betting-system");
      if (existsSync(path.join(candidate, "data", "bankroll.json"))) return candidate;
    }
  }
  return null;
}

async function readBettingSystemData(dir: string): Promise<{
  bankroll: FilesBankroll | null;
  betsLog: FilesBetEntry[];
  simulations: BettingOpsDashboardSimulation[];
  dailyPerformance: BettingOpsDashboardDailyPerf[];
}> {
  const bankrollRaw = await fs
    .readFile(path.join(dir, "data", "bankroll.json"), "utf8")
    .catch(() => null);
  const betsLogRaw = await fs
    .readFile(path.join(dir, "data", "bets_log.json"), "utf8")
    .catch(() => null);
  let bankroll: FilesBankroll | null = null;
  let betsLog: FilesBetEntry[] = [];
  try {
    if (bankrollRaw) bankroll = JSON.parse(bankrollRaw);
  } catch {}
  try {
    if (betsLogRaw) betsLog = JSON.parse(betsLogRaw);
  } catch {}

  const dailyPerformance: BettingOpsDashboardDailyPerf[] =
    (bankroll?.daily_history ?? []).map((day) => ({
      date: day.date,
      openingBankroll: day.opening,
      closingBankroll: day.closing,
      profitLoss: day.profit_loss,
      betsCount: day.bets,
    }));

  // Add today's live session if not already in daily_history
  if (bankroll?.today_date && bankroll.today_opening_bankroll != null && bankroll.today_profit_loss != null) {
    const todayAlreadyInHistory = dailyPerformance.some((d) => d.date === bankroll.today_date);
    if (!todayAlreadyInHistory) {
      dailyPerformance.push({
        date: bankroll.today_date,
        openingBankroll: bankroll.today_opening_bankroll,
        closingBankroll: bankroll.current_bankroll,
        profitLoss: bankroll.today_profit_loss,
        betsCount: bankroll.today_bets_count ?? 0,
      });
    }
  }

  const simulations: BettingOpsDashboardSimulation[] = [];
  const simDir = path.join(dir, "reports", "simulations");
  const simEntries = await fs.readdir(simDir, { withFileTypes: true }).catch(() => []);
  for (const entry of simEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(simDir, entry.name), "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        mode?: string;
        session_date?: string;
        generated_at?: string;
        summary?: {
          would_be_bets?: number;
          total_recommended_stake?: number;
          projected_profit_loss?: number;
          projected_roi_pct?: number;
          won?: number;
          lost?: number;
        };
        would_be_bets?: Array<{
          bet_id?: string;
          rank?: number;
          bet_type?: string;
          market?: string;
          total_odds?: number;
          recommended_stake?: number;
          selections?: Array<{ sport?: string; league?: string }>;
          outcome?: { status?: string; profit_loss?: number };
        }>;
      };
      if (parsed.mode !== "simulation" || !parsed.session_date) continue;
      const bets: BettingOpsDashboardSimBet[] = (parsed.would_be_bets ?? []).map((b) => ({
        betId: b.bet_id ?? entry.name,
        rank: b.rank ?? 0,
        betType: b.bet_type ?? "single",
        market: b.market ?? "Unknown",
        totalOdds: b.total_odds ?? 0,
        recommendedStake: b.recommended_stake ?? 0,
        sport: b.selections?.[0]?.sport ?? null,
        league: b.selections?.[0]?.league ?? null,
        outcomeStatus: b.outcome?.status ?? "unknown",
        profitLoss: b.outcome?.profit_loss ?? 0,
      }));
      simulations.push({
        id: entry.name.replace(".json", ""),
        sessionDate: parsed.session_date,
        generatedAt: parsed.generated_at ?? parsed.session_date,
        wouldBeBets: parsed.summary?.would_be_bets ?? bets.length,
        totalRecommendedStake: parsed.summary?.total_recommended_stake ?? 0,
        projectedProfitLoss: parsed.summary?.projected_profit_loss ?? 0,
        projectedRoiPct: parsed.summary?.projected_roi_pct ?? 0,
        won: parsed.summary?.won ?? 0,
        lost: parsed.summary?.lost ?? 0,
        bets,
      });
    } catch {}
  }
  simulations.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  return { bankroll, betsLog, simulations, dailyPerformance };
}

function mapFileBetToEntry(bet: FilesBetEntry): BettingOpsDashboardEntry {
  const primary = bet.selections[0];
  const isCombo = bet.selections.length > 1;
  const matchLabel = isCombo
    ? bet.selections.map((s) => `${s.home_team} vs ${s.away_team}`).join(" + ")
    : primary
      ? `${primary.home_team} vs ${primary.away_team}`
      : "Unknown";
  const pick = isCombo
    ? bet.selections.map((s) => (s.selection === "home" ? s.home_team : s.away_team)).join(" + ")
    : primary
      ? primary.selection === "home"
        ? primary.home_team
        : primary.away_team
      : "Unknown";
  return {
    id: bet.id,
    kind: "placed",
    status: bet.status,
    matchLabel,
    sport: isCombo ? null : (primary?.sport ?? null),
    league: isCombo ? null : (primary?.league ?? null),
    startsAt: bet.placed_at,
    settledAt: bet.settled_at && bet.settled_at !== bet.placed_at ? bet.settled_at : null,
    pick,
    market: bet.bet_type,
    confidencePercent: primary ? Number((primary.estimated_probability * 100).toFixed(2)) : null,
    edgePercent: primary ? Number((primary.edge * 100).toFixed(2)) : null,
    odds: primary ? primary.odds : bet.total_odds,
    targetOdds: null,
    stake: bet.stake,
    bookmaker: null,
    source: "file:bets_log",
    agentName: null,
    taskIdentifier: null,
    reasoning: primary?.reasoning ?? null,
    profitLoss: bet.profit_loss,
    currency: "USD",
    createdAt: bet.placed_at,
  };
}

export function bettingOpsDashboardService(db: Db) {
  return {
    summary: async (companyId: string): Promise<BettingOpsDashboardData> => {
      const now = new Date();
      const companyAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentIds = companyAgents.map((agent) => agent.id);
      const agentNameById = new Map(companyAgents.map((agent) => [agent.id, agent.name]));

      const snapshots = await db
        .select({
          balance: bettingBankrollSnapshots.balance,
          currency: bettingBankrollSnapshots.currency,
          snapshotAt: bettingBankrollSnapshots.snapshotAt,
        })
        .from(bettingBankrollSnapshots)
        .where(eq(bettingBankrollSnapshots.companyId, companyId))
        .orderBy(asc(bettingBankrollSnapshots.snapshotAt));

      const matches = await db
        .select()
        .from(bettingMatches)
        .where(eq(bettingMatches.companyId, companyId))
        .orderBy(asc(bettingMatches.startsAt));

      const predictionRows = await db
        .select({
          id: bettingPredictions.id,
          agentId: bettingPredictions.agentId,
          prediction: bettingPredictions.prediction,
          confidence: bettingPredictions.confidence,
          expectedValue: bettingPredictions.expectedValue,
          targetOdds: bettingPredictions.targetOdds,
          reasoning: bettingPredictions.reasoning,
          status: bettingPredictions.status,
          createdAt: bettingPredictions.createdAt,
          matchId: bettingPredictions.matchId,
          sport: bettingMatches.sport,
          league: bettingMatches.league,
          homeTeam: bettingMatches.homeTeam,
          awayTeam: bettingMatches.awayTeam,
          startsAt: bettingMatches.startsAt,
        })
        .from(bettingPredictions)
        .innerJoin(bettingMatches, eq(bettingPredictions.matchId, bettingMatches.id))
        .where(eq(bettingPredictions.companyId, companyId))
        .orderBy(desc(bettingPredictions.createdAt));

      const placedRows = await db
        .select({
          id: bettingPlacedBets.id,
          predictionId: bettingPlacedBets.predictionId,
          bookmaker: bettingPlacedBets.bookmaker,
          odds: bettingPlacedBets.odds,
          stake: bettingPlacedBets.stake,
          currency: bettingPlacedBets.currency,
          status: bettingPlacedBets.status,
          executionStatus: bettingPlacedBets.executionStatus,
          executionLedger: bettingPlacedBets.executionLedger,
          profitLoss: bettingPlacedBets.profitLoss,
          placedAt: bettingPlacedBets.placedAt,
          prediction: bettingPredictions.prediction,
          confidence: bettingPredictions.confidence,
          expectedValue: bettingPredictions.expectedValue,
          targetOdds: bettingPredictions.targetOdds,
          reasoning: bettingPredictions.reasoning,
          agentId: bettingPredictions.agentId,
          sport: bettingMatches.sport,
          league: bettingMatches.league,
          homeTeam: bettingMatches.homeTeam,
          awayTeam: bettingMatches.awayTeam,
          startsAt: bettingMatches.startsAt,
        })
        .from(bettingPlacedBets)
        .leftJoin(bettingPredictions, eq(bettingPlacedBets.predictionId, bettingPredictions.id))
        .leftJoin(bettingMatches, eq(bettingPredictions.matchId, bettingMatches.id))
        .where(eq(bettingPlacedBets.companyId, companyId))
        .orderBy(desc(bettingPlacedBets.placedAt));

      const issueRows = agentIds.length
        ? await db
          .select({
            assigneeAgentId: issues.assigneeAgentId,
            status: issues.status,
            completedAt: issues.completedAt,
            identifier: issues.identifier,
            title: issues.title,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.assigneeAgentId, agentIds)))
        : [];

      const recentRuns = agentIds.length
        ? await db
          .select({
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            startedAt: heartbeatRuns.startedAt,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.agentId, agentIds),
              gte(heartbeatRuns.createdAt, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
            ),
          )
        : [];

      const reports = await collectReportArtifacts(agentIds);

      const bettingSystemDir = await findBettingSystemDir(companyId);
      const {
        bankroll: filesBankroll,
        betsLog: filesBetsLog,
        simulations,
        dailyPerformance,
      } = bettingSystemDir
        ? await readBettingSystemData(bettingSystemDir)
        : { bankroll: null, betsLog: [], simulations: [], dailyPerformance: [] };
      const useFileBankroll = snapshots.length === 0 && filesBankroll != null;
      const useFileBets = placedRows.length === 0 && filesBetsLog.length > 0;

      const predictionIssueByTask = new Map<string, string>();
      for (const issue of issueRows) {
        if (!issue.identifier) continue;
        predictionIssueByTask.set(issue.identifier, issue.identifier);
      }

      const predictionEntries: BettingOpsDashboardEntry[] = predictionRows.map((row) => ({
        id: row.id,
        kind: "recommended",
        status: row.status,
        matchLabel: `${row.homeTeam} vs ${row.awayTeam}`,
        sport: row.sport,
        league: row.league,
        startsAt: row.startsAt?.toISOString() ?? null,
        settledAt: null,
        pick: row.prediction,
        market: null,
        confidencePercent: row.confidence,
        edgePercent:
          row.expectedValue == null
            ? null
            : Math.abs(row.expectedValue) <= 1
              ? row.expectedValue * 100
              : row.expectedValue,
        odds: row.targetOdds ?? null,
        targetOdds: row.targetOdds ?? null,
        stake: null,
        bookmaker: null,
        source: "db:prediction",
        agentName: row.agentId ? agentNameById.get(row.agentId) ?? null : null,
        taskIdentifier: predictionIssueByTask.get(row.id) ?? null,
        reasoning: row.reasoning,
        profitLoss: null,
        currency: "USD",
        createdAt: row.createdAt.toISOString(),
      }));

      const placedEntries: BettingOpsDashboardEntry[] = placedRows.map((row) => {
        const ledger = row.executionLedger as Record<string, unknown> | null;
        const ledgerMatchLabel =
          typeof ledger?.matchLabel === "string" && ledger.matchLabel.trim().length > 0
            ? ledger.matchLabel
            : null;
        const ledgerMarket =
          typeof ledger?.market === "string" && ledger.market.trim().length > 0
            ? ledger.market
            : null;
        const ledgerSelection =
          typeof ledger?.intendedSelection === "string" && ledger.intendedSelection.trim().length > 0
            ? ledger.intendedSelection
            : null;
        return {
          id: row.id,
          kind: "placed",
          status: row.status,
          matchLabel: ledgerMatchLabel ?? `${row.homeTeam ?? "Unknown"} vs ${row.awayTeam ?? "Unknown"}`,
        sport: row.sport,
        league: row.league,
        startsAt: row.startsAt?.toISOString() ?? null,
        settledAt: null,
        pick: row.prediction ?? ledgerSelection ?? "Unknown selection",
        market: ledgerMarket,
        confidencePercent: row.confidence,
        edgePercent:
          row.expectedValue == null
            ? null
            : Math.abs(row.expectedValue) <= 1
              ? row.expectedValue * 100
              : row.expectedValue,
        odds: row.odds,
        targetOdds: row.targetOdds ?? null,
        stake: row.stake,
        bookmaker: row.bookmaker,
        source: "db:placed_bet",
        agentName: row.agentId ? agentNameById.get(row.agentId) ?? null : null,
        taskIdentifier: null,
        reasoning: row.reasoning,
        profitLoss: row.profitLoss ?? null,
        currency: row.currency ?? "USD",
        createdAt: row.placedAt.toISOString(),
        };
      });

      const filePlacedEntries = useFileBets ? filesBetsLog.map(mapFileBetToEntry) : [];
      const entries = [...placedEntries, ...filePlacedEntries, ...predictionEntries, ...reports.entries].sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt),
      );

      const trackedMatchIdsWithRecommendation = new Set(predictionRows.map((row) => row.matchId));
      const trackedMatchLabelsWithPlaced = new Set(
        placedRows.map((row) => `${row.homeTeam} vs ${row.awayTeam}`),
      );
      const trackedMatches: BettingOpsDashboardMatch[] = matches.map((match) => ({
        id: match.id,
        externalId: match.externalId ?? null,
        sport: match.sport,
        league: match.league,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        startsAt: match.startsAt.toISOString(),
        status: match.status,
        sourceCount: match.oddsJson ? Object.keys(match.oddsJson).length : 0,
        hasRecommendation: trackedMatchIdsWithRecommendation.has(match.id),
        hasPlacedBet: trackedMatchLabelsWithPlaced.has(`${match.homeTeam} vs ${match.awayTeam}`),
      }));

      const resolvedPlaced = useFileBets
        ? filesBetsLog.filter((b) => b.status === "won" || b.status === "lost" || b.status === "void")
        : placedRows.filter((row) => row.status === "won" || row.status === "lost" || row.status === "void");
      const wonCount = useFileBets
        ? filesBetsLog.filter((b) => b.status === "won").length
        : placedRows.filter((row) => row.status === "won").length;
      const totalStake = resolvedPlaced.reduce(
        (sum, row) => sum + ((row as { stake?: number | null }).stake ?? 0),
        0,
      );
      const totalProfit = resolvedPlaced.reduce(
        (sum, row) => sum + ((row as { profitLoss?: number | null; profit_loss?: number | null }).profitLoss ?? (row as { profit_loss?: number | null }).profit_loss ?? 0),
        0,
      );

      let currentBalance: number | null;
      let initialBankroll: number | null;
      let totalPnl: number | null;
      let totalPnlPercent: number | null;
      let todayPnl: number;
      let todayBaseline: number | null;
      let bankrollSeriesSource: Array<{ timestamp: Date; balance: number }>;

      if (useFileBankroll) {
        const history = filesBankroll!.daily_history ?? [];
        const firstDay = history[0] ?? null;
        const lastDay = history.at(-1) ?? null;
        initialBankroll = firstDay?.opening ?? null;
        currentBalance = filesBankroll!.current_bankroll;
        todayBaseline = filesBankroll!.today_opening_bankroll ?? lastDay?.closing ?? null;
        todayPnl = filesBankroll!.today_profit_loss ?? 0;
        totalPnl =
          filesBankroll!.total_lifetime_profit ??
          (initialBankroll != null ? currentBalance - initialBankroll : null);
        totalPnlPercent =
          initialBankroll && initialBankroll !== 0 && totalPnl != null
            ? Number(((totalPnl / initialBankroll) * 100).toFixed(2))
            : null;
        bankrollSeriesSource = history.map((day) => ({
          timestamp: new Date(day.date + "T23:59:59Z"),
          balance: day.closing,
        }));
        // Append today's live balance if not already present
        const todayDateStr = filesBankroll!.today_date;
        const lastSeriesDate = history.at(-1)?.date;
        if (todayDateStr && todayDateStr !== lastSeriesDate && filesBankroll!.current_bankroll) {
          bankrollSeriesSource.push({
            timestamp: new Date(todayDateStr + "T23:59:59Z"),
            balance: filesBankroll!.current_bankroll,
          });
        }
      } else {
        const firstSnapshot = snapshots[0] ?? null;
        const latestSnapshot = snapshots.at(-1) ?? null;
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        const beforeToday = [...snapshots].reverse().find((s) => s.snapshotAt < dayStart);
        todayBaseline = beforeToday?.balance ?? firstSnapshot?.balance ?? latestSnapshot?.balance ?? null;
        currentBalance = latestSnapshot?.balance ?? null;
        todayPnl = todayBaseline != null && currentBalance != null ? currentBalance - todayBaseline : 0;
        initialBankroll = firstSnapshot?.balance ?? null;
        totalPnl =
          firstSnapshot && latestSnapshot ? latestSnapshot.balance - firstSnapshot.balance : null;
        totalPnlPercent =
          firstSnapshot && latestSnapshot && firstSnapshot.balance !== 0
            ? Number(
              (
                ((latestSnapshot.balance - firstSnapshot.balance) / firstSnapshot.balance) *
                100
              ).toFixed(2),
            )
            : null;
        bankrollSeriesSource = snapshots.map((snapshot) => ({
          timestamp: snapshot.snapshotAt,
          balance: snapshot.balance,
        }));
      }

      const bankrollSeries: BettingOpsDashboardSeriesCollection = {
        daily: groupSeriesPoints(bankrollSeriesSource.slice(-30), "day"),
        weekly: groupSeriesPoints(bankrollSeriesSource.slice(-90), "week"),
        monthly: groupSeriesPoints(bankrollSeriesSource, "month"),
      };

      const sportDistributionMap = new Map<string, number>();
      const leagueDistributionMap = new Map<string, number>();
      for (const entry of entries) {
        pushDistribution(sportDistributionMap, entry.sport);
        pushDistribution(leagueDistributionMap, entry.league);
      }

      const roiByBetTypeMap = new Map<string, { stake: number; pnl: number }>();
      for (const entry of [...placedEntries, ...filePlacedEntries]) {
        const key = entry.market ?? "Necunoscut";
        const current = roiByBetTypeMap.get(key) ?? { stake: 0, pnl: 0 };
        current.stake += entry.stake ?? 0;
        current.pnl += entry.profitLoss ?? 0;
        roiByBetTypeMap.set(key, current);
      }
      const roiByBetType: BettingOpsDashboardDistributionPoint[] = [...roiByBetTypeMap.entries()]
        .map(([label, value]) => ({
          label,
          value: value.stake > 0 ? Number(((value.pnl / value.stake) * 100).toFixed(2)) : 0,
        }))
        .sort((left, right) => right.value - left.value);

      const runsByAgent = new Map<string, { runs7d: number; failedRuns7d: number }>();
      for (const run of recentRuns) {
        const current = runsByAgent.get(run.agentId) ?? { runs7d: 0, failedRuns7d: 0 };
        current.runs7d += 1;
        if (!["done", "running", "queued"].includes(run.status)) current.failedRuns7d += 1;
        runsByAgent.set(run.agentId, current);
      }

      const issuesByAgent = new Map<string, { openIssues: number; completedIssues30d: number }>();
      const completedWindow = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      for (const issue of issueRows) {
        if (!issue.assigneeAgentId) continue;
        const current = issuesByAgent.get(issue.assigneeAgentId) ?? {
          openIssues: 0,
          completedIssues30d: 0,
        };
        if (!["done", "cancelled"].includes(issue.status)) current.openIssues += 1;
        if (issue.status === "done" && issue.completedAt && issue.completedAt >= completedWindow) {
          current.completedIssues30d += 1;
        }
        issuesByAgent.set(issue.assigneeAgentId, current);
      }

      const predictionCountsByAgent = new Map<string, { recommendations: number; placedBets: number }>();
      for (const prediction of predictionRows) {
        if (!prediction.agentId) continue;
        const current = predictionCountsByAgent.get(prediction.agentId) ?? {
          recommendations: 0,
          placedBets: 0,
        };
        current.recommendations += 1;
        predictionCountsByAgent.set(prediction.agentId, current);
      }
      for (const placed of placedRows) {
        if (!placed.agentId) continue;
        const current = predictionCountsByAgent.get(placed.agentId) ?? {
          recommendations: 0,
          placedBets: 0,
        };
        current.placedBets += 1;
        predictionCountsByAgent.set(placed.agentId, current);
      }

      const agentMetrics: BettingOpsDashboardAgentMetric[] = companyAgents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role ?? null,
        status: agent.status,
        runs7d: runsByAgent.get(agent.id)?.runs7d ?? 0,
        failedRuns7d: runsByAgent.get(agent.id)?.failedRuns7d ?? 0,
        openIssues: issuesByAgent.get(agent.id)?.openIssues ?? 0,
        completedIssues30d: issuesByAgent.get(agent.id)?.completedIssues30d ?? 0,
        recommendations: predictionCountsByAgent.get(agent.id)?.recommendations ?? 0,
        placedBets: predictionCountsByAgent.get(agent.id)?.placedBets ?? 0,
      }));

      const defaultTargetUrl = "http://localhost:3100/betting-ops";
      const shortcut = buildShortcutInfo(defaultTargetUrl);
      shortcut.installed = await fs
        .access(shortcut.desktopPath)
        .then(() => true)
        .catch(() => false);

      const activePlacedBets = useFileBets
        ? filesBetsLog.filter((b) => b.status === "pending").length
        : placedRows.filter((row) => row.status === "pending").length;

      return {
        companyId,
        generatedAt: now.toISOString(),
        refreshIntervalMs: 60_000,
        overview: {
          currentBankroll: currentBalance,
          initialBankroll,
          totalPnl,
          totalPnlPercent,
          todayPnl: Number(todayPnl.toFixed(2)),
          todayPnlPercent:
            todayBaseline && todayBaseline !== 0
              ? Number(((todayPnl / todayBaseline) * 100).toFixed(2))
              : null,
          openRecommendations: predictionRows.filter((row) => row.status !== "resolved").length,
          activePlacedBets,
          upcomingMatches24h: matches.filter(
            (match) =>
              match.startsAt >= now &&
              match.startsAt <= new Date(now.getTime() + 24 * 60 * 60 * 1000),
          ).length,
          winRatePercent:
            resolvedPlaced.length > 0
              ? Number(((wonCount / resolvedPlaced.length) * 100).toFixed(2))
              : null,
          roiPercent:
            totalStake > 0 ? Number(((totalProfit / totalStake) * 100).toFixed(2)) : null,
        },
        bankrollSeries,
        trackedMatches,
        entries,
        slips: reports.slips,
        sportDistribution: mapToDistribution(sportDistributionMap),
        leagueDistribution: mapToDistribution(leagueDistributionMap),
        roiByBetType,
        agentMetrics,
        shortcut,
        dailyPerformance,
        simulations,
      };
    },

    installShortcut: async (input: {
      targetUrl: string;
    }): Promise<BettingOpsDashboardShortcutInstallResult> => {
      const shortcut = buildShortcutInfo(input.targetUrl.trim() || "http://localhost:3100/betting-ops");
      await fs.mkdir(path.dirname(shortcut.desktopPath), { recursive: true });
      const content = [
        "[InternetShortcut]",
        `URL=${shortcut.targetUrl}`,
        "IconIndex=0",
      ].join("\r\n");
      await fs.writeFile(shortcut.desktopPath, content, "utf8");
      return {
        ...shortcut,
        installed: true,
      };
    },
  };
}
