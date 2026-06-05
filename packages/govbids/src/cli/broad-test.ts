#!/usr/bin/env npx tsx
/**
 * Broad test: sweep 3 weeks with delay between requests, wide value/date filters.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import pc from "picocolors";
import { HigherGovClient } from "../core/highergov-client.js";
import { deduplicateByOpportunityId } from "../core/dedup.js";
import { applyHardFilters } from "../core/hard-filter.js";
import { scoreBatch } from "../core/scorer.js";
import { ENV_VARS, DEFAULT_MIN_SCORE } from "../core/constants.js";
import type { NormalizedOpportunity, PipelineResult } from "../core/types.js";
import { writeJson, writeQualifiedCsv, printSummary } from "./output.js";

const higherGovKey = process.env[ENV_VARS.higherGovApiKey]!;
const claudeKey = process.env[ENV_VARS.claudeApiKey]!;

if (!higherGovKey || !claudeKey) {
  console.error(pc.red(`Set ${ENV_VARS.higherGovApiKey} and ${ENV_VARS.claudeApiKey}`));
  process.exit(1);
}

const client = new HigherGovClient({ apiKey: higherGovKey });
const allOpps = new Map<string, NormalizedOpportunity>();
let totalApiCalls = 0;

// 3 weeks with a pause between each
const weeks = ["2026-04-07", "2026-03-31", "2026-03-24"];

console.log(pc.bold("Step 1: Fetching from HigherGov (3 weekly sweeps with rate limiting)...\n"));

for (const week of weeks) {
  const { opportunities, apiCallsUsed } = await client.fetchAllKeywordSearches({
    capturedAfter: week,
    maxRecords: 300,
  });
  totalApiCalls += apiCallsUsed;
  for (const opp of opportunities) {
    if (!allOpps.has(opp.id)) allOpps.set(opp.id, opp);
  }
  console.log(
    `  Week ${week}: +${opportunities.length} raw, ${pc.cyan(String(allOpps.size))} total unique (${totalApiCalls} API calls)`,
  );
  // Rate limit: wait 3s between weekly sweeps
  if (week !== weeks[weeks.length - 1]) {
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Dedup and filter — broad settings
const deduped = deduplicateByOpportunityId(Array.from(allOpps.values()));

const { kept, dropped } = applyHardFilters(deduped, {
  valueRange: { min: 50_000, max: 2_000_000 },
  dueDateRange: { minDaysFromNow: -90, maxDaysFromNow: 180 },
});

console.log(`\n  Total unique: ${deduped.length}`);
console.log(`  After hard filter: ${pc.green(String(kept.length))} kept, ${dropped.length} dropped`);
console.log(`  API calls: ${totalApiCalls}\n`);

if (kept.length === 0) {
  console.log(pc.red("No opportunities passed hard filter."));
  const reasons: Record<string, number> = {};
  for (const d of dropped) {
    const key = d.reason.split(":")[0].trim();
    reasons[key] = (reasons[key] || 0) + 1;
  }
  for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}x ${r}`);
  }
  process.exit(0);
}

// Score with Claude
console.log(pc.bold(`Step 2: Scoring ${kept.length} opportunities with Claude...\n`));
const scored = await scoreBatch(kept, {
  apiKey: claudeKey,
  onProgress: (done, total) => {
    process.stdout.write(`\r  Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`);
  },
});
console.log("\n");

const minScore = DEFAULT_MIN_SCORE;
const aboveThreshold = scored.filter((o) => o.score >= minScore);

const result: PipelineResult = {
  scored,
  dropped,
  stats: {
    totalFetched: allOpps.size,
    afterDedup: deduped.length,
    afterHardFilter: kept.length,
    scored: scored.length,
    aboveThreshold: aboveThreshold.length,
    apiCallsUsed: totalApiCalls,
    claudeCallsUsed: scored.length,
  },
  runDate: new Date().toISOString(),
};

mkdirSync("data", { recursive: true });
await writeJson(result, "data/scored-broad-test.json");
await writeQualifiedCsv(scored, minScore, "data/qualified-broad-test.csv", "data/rejected-broad-test.csv");

console.log(pc.green(`Qualified CSV: data/qualified-broad-test.csv`));
console.log(pc.dim(`Rejected CSV: data/rejected-broad-test.csv`));

printSummary(result);
