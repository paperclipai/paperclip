/**
 * Off-aggregator discovery — 1-week MEASUREMENT harness.
 *
 * Runs discovery over the unicorn target list, scores what it finds, and logs
 * yield + cost metrics to a ledger. Deliberately standalone: it does NOT touch
 * the production 7 AM pipeline, and uses its OWN seen-ledger so counting
 * net-new doesn't pollute the production seen-set.
 *
 * Modes:
 *   (default)          run a daily discovery pass + append a metrics row
 *   --weekly-summary   read the ledger, compute totals, post a summary to Slack
 *
 * Env: ANTHROPIC_API_KEY, BRAVE_API_KEY (+ SLACK_* for --weekly-summary).
 *
 * Once a week of data shows acceptable net-new qualifying RFPs / $, we wire
 * --discovery into the daily run. Until then this just measures.
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverBySearch } from "../src/core/discovery-source.js";
import { UNICORN_TARGETS } from "../src/core/discovery-targets.js";
import { crossSourceDedup } from "../src/core/cross-source-dedup.js";
import { applyHardFilters } from "../src/core/hard-filter.js";
import { scoreBatch } from "../src/core/scorer.js";
import { classifyOpportunity } from "../src/core/classify.js";
import { SlackClient } from "../src/core/slack-client.js";
import { getStateDir } from "../src/cli/state.js";
import type { NormalizedOpportunity, ScoredOpportunity } from "../src/core/types.js";

const DATA = getStateDir();
const DISCOVERY_DIR = join(DATA, "discovery");
const LEDGER = join(DISCOVERY_DIR, "metrics.jsonl");
const SEEN = join(DISCOVERY_DIR, "discovery-seen.json");

// Rough cost model (paid Brave ~$5/1k; Sonnet small-page extract+score ~$0.004 each).
const BRAVE_COST_PER_QUERY = 0.005;
const LLM_COST_PER_CALL = 0.004;

interface MetricsRow {
  date: string;
  townsSearched: number;
  pagesFetched: number;
  pagesFailed: number;
  rawExtracted: number;
  afterHardFilter: number;
  netNew: number; // not seen by discovery before
  qualified: number; // scored >= 50, no disqualifiers, type=rfp
  braveQueries: number;
  llmCalls: number;
  estCostUsd: number;
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function todayStr(): string {
  // launchd passes the date via env when needed; default to wall-clock date.
  return new Date().toISOString().slice(0, 10);
}

async function runDaily(townCap: number): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  const date = process.env.DISCOVERY_DATE ?? todayStr();
  const targets = UNICORN_TARGETS.slice(0, townCap);

  const { opportunities, pagesFetched, pagesFailed } = await discoverBySearch({
    anthropicKey: process.env.ANTHROPIC_API_KEY!,
    braveKey: process.env.BRAVE_API_KEY!,
    targets,
    resultsPerTarget: 6,
    pagesPerTarget: 2,
    throttleMs: 300,
    onProgress: (d, t, label) =>
      process.stdout.write(`\r  ${d}/${t}  ${label.padEnd(26)}`),
  });
  process.stdout.write("\n");

  // Dedup within the discovery batch.
  const { deduped } = crossSourceDedup(opportunities);
  // Hard-filter (biddable type + due-date window; ongoing exemption applies).
  const { kept } = applyHardFilters(deduped);

  // Net-new vs the discovery seen-ledger (separate from production seen-set).
  const seen = await loadJson<{ ids: Record<string, string> }>(SEEN, { ids: {} });
  const netNew = kept.filter((o) => !seen.ids[o.id]);

  // Score only the net-new (cheap — usually a handful).
  let scored: ScoredOpportunity[] = [];
  if (netNew.length > 0 && process.env.ANTHROPIC_API_KEY) {
    scored = await scoreBatch(netNew, { apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const qualified = scored.filter(
    (o) =>
      o.score >= 50 &&
      (!o.disqualifiers || o.disqualifiers.length === 0) &&
      classifyOpportunity(o).type === "rfp",
  );

  // Mark net-new as seen by discovery so tomorrow doesn't recount them.
  for (const o of netNew) seen.ids[o.id] = date;
  await writeFile(SEEN, JSON.stringify(seen, null, 2));

  const braveQueries = targets.length * 2; // resolve + procurement search
  const llmCalls = pagesFetched + netNew.length; // extract per page + score per net-new
  const row: MetricsRow = {
    date,
    townsSearched: targets.length,
    pagesFetched,
    pagesFailed,
    rawExtracted: opportunities.length,
    afterHardFilter: kept.length,
    netNew: netNew.length,
    qualified: qualified.length,
    braveQueries,
    llmCalls,
    estCostUsd:
      braveQueries * BRAVE_COST_PER_QUERY + llmCalls * LLM_COST_PER_CALL,
  };
  await appendFile(LEDGER, JSON.stringify(row) + "\n");

  // Persist the qualifying discoveries for review.
  if (qualified.length > 0) {
    await writeFile(
      join(DISCOVERY_DIR, `discovered-${date}.json`),
      JSON.stringify(qualified, null, 2),
    );
  }

  console.log(
    `\n[${date}] towns ${row.townsSearched} · pages ${pagesFetched}/${pagesFetched + pagesFailed} · ` +
      `raw ${row.rawExtracted} · filtered ${row.afterHardFilter} · net-new ${row.netNew} · ` +
      `qualified ${row.qualified} · ~$${row.estCostUsd.toFixed(2)}`,
  );
  for (const o of qualified) {
    console.log(`   ✅ [${o.state}] ${o.agency}: ${o.title.slice(0, 50)} (${o.score})`);
  }
}

async function weeklySummary(): Promise<void> {
  const lines = (await readFile(LEDGER, "utf-8").catch(() => "")).trim().split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l) as MetricsRow);
  if (rows.length === 0) {
    console.log("No metrics yet.");
    return;
  }
  const sum = (k: keyof MetricsRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const days = rows.length;
  const totalQualified = sum("qualified");
  const totalCost = sum("estCostUsd");
  const costPerQualified = totalQualified > 0 ? totalCost / totalQualified : 0;

  const lines2 = [
    `:satellite: *Off-aggregator discovery — ${days}-day measurement*`,
    `Scanning overlooked fast-growing towns the major portals miss.`,
    "",
    `• Towns/day: ${rows[rows.length - 1].townsSearched}`,
    `• Net-new qualifying RFPs found: *${totalQualified}* over ${days} days (${(totalQualified / days).toFixed(1)}/day)`,
    `• Pages reached: ${sum("pagesFetched")} (failed/blocked: ${sum("pagesFailed")})`,
    `• Est. cost: $${totalCost.toFixed(2)} total · *$${costPerQualified.toFixed(2)}/qualified RFP*`,
    "",
    totalQualified >= days // ≥1/day average → worth wiring in
      ? ":white_check_mark: Yield looks worth folding into the daily run — recommend going live."
      : ":hourglass_flowing_sand: Yield still thin — keep measuring / widen the town list before going live.",
  ];
  console.log(lines2.join("\n"));

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
    const slack = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });
    await slack.postMessage({
      channelId: process.env.SLACK_CHANNEL_ID,
      text: lines2.join("\n"),
    });
    console.log("\nPosted weekly summary to Slack.");
  }
}

async function main() {
  if (process.argv.includes("--weekly-summary")) {
    await weeklySummary();
    return;
  }
  const capArg = process.argv.find((a) => a.startsWith("--towns="));
  const townCap = capArg ? parseInt(capArg.split("=")[1], 10) : UNICORN_TARGETS.length;
  await runDaily(townCap);
}

main().catch((e: Error) => {
  console.error("discovery-run FAILED:", e.message);
  process.exit(1);
});
