import type { Db } from "@paperclipai/db";
import { bettingMatches, companies } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const STATPAL_BASE = "https://statpal.io/api/v2";
const INGEST_INTERVAL_MS = 30 * 60 * 1000; // 30 min

let ingestTimer: ReturnType<typeof setInterval> | null = null;

interface StatPalMatch {
  main_id: string;
  status: string;
  date: string;
  time: string;
  home: { id: string; name: string; goals: string };
  away: { id: string; name: string; goals: string };
}

interface StatPalLeague {
  id: string;
  name: string;
  country: string;
  match: StatPalMatch | StatPalMatch[];
}

interface StatPalLiveResponse {
  live_matches: {
    updated: string;
    league: StatPalLeague | StatPalLeague[];
  };
}

function parseDate(date: string, time: string): Date | null {
  // date format: "22.04.2026", time: "17:00"
  const [day, month, year] = date.split(".");
  if (!day || !month || !year) return null;
  const [hour, minute] = time.split(":");
  return new Date(`${year}-${month}-${day}T${hour ?? "00"}:${minute ?? "00"}:00.000Z`);
}

function matchStatus(goals: string): string {
  return goals === "?" ? "upcoming" : "live";
}

async function fetchAndIngest(db: Db, companyId: string, apiKey: string): Promise<number> {
  const url = `${STATPAL_BASE}/soccer/matches/live?access_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    logger.warn({ status: res.status }, "odds-ingestion: StatPal API error");
    return 0;
  }

  const data = (await res.json()) as StatPalLiveResponse;
  const leagueRaw = data?.live_matches?.league;
  if (!leagueRaw) return 0;

  const leagues = Array.isArray(leagueRaw) ? leagueRaw : [leagueRaw];
  let upserted = 0;

  for (const league of leagues) {
    const matches = Array.isArray(league.match) ? league.match : [league.match];
    for (const match of matches) {
      const startsAt = parseDate(match.date, match.time);
      if (!startsAt) continue;

      const status = matchStatus(match.home.goals);
      const existing = await db
        .select({ id: bettingMatches.id, status: bettingMatches.status })
        .from(bettingMatches)
        .where(and(eq(bettingMatches.companyId, companyId), eq(bettingMatches.externalId, match.main_id)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        await db
          .update(bettingMatches)
          .set({ status, updatedAt: new Date() })
          .where(eq(bettingMatches.id, existing.id));
      } else {
        await db.insert(bettingMatches).values({
          companyId,
          externalId: match.main_id,
          sport: "soccer",
          league: `${league.name} (${league.country})`,
          homeTeam: match.home.name,
          awayTeam: match.away.name,
          startsAt,
          status,
        });
      }
      upserted++;
    }
  }

  return upserted;
}

export async function runOddsIngestion(db: Db): Promise<void> {
  const apiKey =
    process.env.SPORTS_DATA_API_KEY?.trim() ??
    process.env.STATPAL_API_KEY?.trim() ??
    process.env.STATPAL_ACCESS_KEY?.trim() ??
    "";
  if (!apiKey) {
    logger.warn(
      "odds-ingestion: SPORTS_DATA_API_KEY/STATPAL_API_KEY/STATPAL_ACCESS_KEY not set — skipping",
    );
    return;
  }

  const activeCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(inArray(companies.status, ["active", "trial"]));
  if (activeCompanies.length === 0) return;

  let total = 0;
  for (const company of activeCompanies) {
    try {
      total += await fetchAndIngest(db, company.id, apiKey);
    } catch (err) {
      logger.warn({ err }, "odds-ingestion: fetch failed");
    }
  }
  if (total > 0) {
    logger.info({ total }, "odds-ingestion: matches upserted from StatPal");
  }
}

export function startOddsIngestion(db: Db): void {
  if (ingestTimer) return;
  void runOddsIngestion(db);
  ingestTimer = setInterval(() => void runOddsIngestion(db), INGEST_INTERVAL_MS);
  ingestTimer.unref?.();
  logger.info("odds-ingestion: started (30-min interval, StatPal.io)");
}

export function stopOddsIngestion(): void {
  if (ingestTimer) {
    clearInterval(ingestTimer);
    ingestTimer = null;
  }
}
