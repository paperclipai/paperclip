#!/usr/bin/env node
/**
 * Backfill niche_opportunities.json → Paperclip DB via POST API.
 * Run once to sync the 145 existing niches from local JSON.
 * 409 conflicts (duplicates) are silently skipped.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const API_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100";
const API_KEY = process.env.PAPERCLIP_API_KEY ?? null;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "e13e35ac-a13d-4330-80ad-aa5a51777b22";
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? "backfill-manual";

const JSON_PATH = join(
  homedir(),
  ".paperclip",
  "instances",
  "default",
  "nda-state",
  "niche_opportunities.json",
);

const niches = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
console.log(`Loaded ${niches.length} niches from ${JSON_PATH}`);

const endpoint = `${API_URL}/api/companies/${COMPANY_ID}/niche-opportunities`;

let created = 0;
let skipped = 0;
let errors = 0;

for (const n of niches) {
  const categoryPath = Array.isArray(n.category_path)
    ? n.category_path.join(" > ")
    : n.category_path;

  const metadata = JSON.stringify({
    scoring: {
      demand: n.demand_score,
      competition: n.competition_score,
      monetization: n.monetization_score,
      defensibility: n.defensibility_score,
      risk: n.risk_score,
      royaltyPerUnit: n.royalty_per_unit ?? null,
    },
    signals: {
      bsrMedianTop30: n.bsr_median,
      estimatedMonthlySales: n.estimated_monthly_sales,
      keywordSearchVolume: n.keyword_search_volume,
      medianPrice: n.median_price,
      competitivenessIndex: n.competitiveness_index ?? null,
      longTailVariants: n.long_tail_variants ?? null,
      qualifiedTitlesInTop30: n.qualified_titles_in_top30 ?? null,
      demandShape: n.demand_shape ?? null,
      kdpPolicyProximity: n.kdp_policy_proximity ?? null,
      seasonalityCliffRisk: n.seasonality_cliff_risk ?? null,
    },
    reviewGaps: n.review_gap_excerpts ?? [],
    hardGuardTriggered: n.hard_guard_triggered ?? null,
    cycleId: n.cycle_id ?? null,
    ndaRunId: n.nda_run_id ?? null,
    competitorSnapshot: n.competitor_snapshot ?? [],
    pricingData: n.pricing_data ?? null,
    categoryId: n.category_id ?? null,
  });

  const body = {
    headKeyword: n.head_keyword,
    categoryPath,
    tier: n.tier,
    compositeScore: n.composite_score,
    discoveredAt: n.discovered_at,
    metadata,
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        "X-Paperclip-Run-Id": RUN_ID,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 201) {
      created++;
      console.log(`  ✓ ${n.head_keyword} (${n.tier}, ${n.composite_score})`);
    } else if (res.status === 409) {
      skipped++;
      console.log(`  ~ ${n.head_keyword} — duplicate, skipped`);
    } else {
      errors++;
      const text = await res.text();
      console.error(`  ✗ ${n.head_keyword} — HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    errors++;
    console.error(`  ✗ ${n.head_keyword} — fetch error: ${err.message}`);
  }
}

console.log(`\nDone: ${created} created, ${skipped} skipped (duplicate), ${errors} errors`);
if (errors > 0) process.exit(1);
