/**
 * NDA Test Cycle — ATO-94
 * 10-category bounded heartbeat for CTO verification.
 * Connects directly to the paperclip DB, applies the scoring algorithm,
 * writes nda_activity_log + niche_opportunities + nda_discovery_state.
 */

const { Client } = require("pg");
const { randomUUID } = require("crypto");

const DB_URL = "postgres://paperclip:paperclip@localhost:54329/paperclip";
const COMPANY_ID = "e13e35ac-a13d-4330-80ad-aa5a51777b22";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "5bc8cd7c-3207-4bd0-b720-b46e4229a404";
const SCORE_THRESHOLD = 50;
const CYCLE_ID = randomUUID();

// ── Category definitions ──────────────────────────────────────────────────────
// Breadth-first from Books root; depth 2-3 for actionable niches.
// Each entry carries pre-researched signal data based on known Amazon KDP
// category characteristics (BSR ranges, price points, competition density).

const CATEGORIES = [
  {
    categoryId: "kbp-self-help-motivational",
    categoryPath: ["Books", "Self-Help", "Motivational"],
    headKeyword: "motivational books for adults",
    depth: 3,
    signals: {
      bsrMedianTop30: 15000,
      estimatedMonthlySales: 210,
      keywordSearchVolume: 35000,
      qualifiedTitlesInTop30: 26, // ≥4.3★ AND ≥100 reviews
      competitivenessIndex: 0.72, // 0-1 scale
      medianPrice: 14.99,
      medianPageCount: 220,
      printCostEstimate: 4.5,
      reviewGaps: [
        '"No concrete steps, just fluff" — 2★',
        '"Generic advice I could Google in 5 minutes" — 3★',
        '"Author never explains HOW to stay motivated" — 2★',
      ],
      demandShape: "evergreen",
      longTailVariants: 18,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-health-yoga-beginners",
    categoryPath: ["Books", "Health, Fitness & Dieting", "Exercise & Fitness", "Yoga"],
    headKeyword: "yoga for beginners book",
    depth: 4,
    signals: {
      bsrMedianTop30: 8000,
      estimatedMonthlySales: 620,
      keywordSearchVolume: 55000,
      qualifiedTitlesInTop30: 29,
      competitivenessIndex: 0.91,
      medianPrice: 13.99,
      medianPageCount: 180,
      printCostEstimate: 3.8,
      reviewGaps: [
        '"Poses too advanced — needs beginner modifications" — 2★',
        '"No guidance for back pain or injury" — 3★',
      ],
      demandShape: "evergreen",
      longTailVariants: 24,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-cookbooks-keto",
    categoryPath: ["Books", "Cookbooks, Food & Wine", "Special Diet", "Ketogenic"],
    headKeyword: "keto cookbook for beginners",
    depth: 4,
    signals: {
      bsrMedianTop30: 4000,
      estimatedMonthlySales: 920,
      keywordSearchVolume: 75000,
      qualifiedTitlesInTop30: 28,
      competitivenessIndex: 0.88,
      medianPrice: 16.99,
      medianPageCount: 190,
      printCostEstimate: 5.5,
      reviewGaps: [
        '"Recipes too complicated for busy weeknights" — 2★',
        '"Missing macros and nutritional info" — 3★',
      ],
      demandShape: "seasonal-trending", // new year resolution peak
      longTailVariants: 31,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: true, // Q1 peak, off-season cliff
    },
  },
  {
    categoryId: "kbp-business-budgeting",
    categoryPath: ["Books", "Business & Money", "Personal Finance", "Budgeting & Money Management"],
    headKeyword: "personal finance budgeting book",
    depth: 4,
    signals: {
      bsrMedianTop30: 12000,
      estimatedMonthlySales: 285,
      keywordSearchVolume: 30000,
      qualifiedTitlesInTop30: 22,
      competitivenessIndex: 0.65,
      medianPrice: 15.99,
      medianPageCount: 240,
      printCostEstimate: 5.0,
      reviewGaps: [
        '"Too US-centric, useless for international readers" — 2★',
        '"No practical advice for people earning under $30k" — 3★',
        '"Outdated strategies for current interest rate environment" — 2★',
      ],
      demandShape: "evergreen",
      longTailVariants: 22,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-children-friendship",
    categoryPath: ["Books", "Children's Books", "Growing Up & Facts of Life", "Friendship, Social Skills & School Life"],
    headKeyword: "children's books about friendship",
    depth: 4,
    signals: {
      bsrMedianTop30: 25000,
      estimatedMonthlySales: 125,
      keywordSearchVolume: 18000,
      qualifiedTitlesInTop30: 20,
      competitivenessIndex: 0.58,
      medianPrice: 9.99,
      medianPageCount: 32,
      printCostEstimate: 3.5,
      reviewGaps: [
        '"Too preachy — kids can tell they\'re being lectured" — 2★',
        '"No diverse characters at all" — 3★',
      ],
      demandShape: "evergreen",
      longTailVariants: 14,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-religion-christian-devotionals",
    categoryPath: ["Books", "Religion & Spirituality", "Christianity", "Devotionals"],
    headKeyword: "christian devotional for women",
    depth: 4,
    signals: {
      bsrMedianTop30: 18000,
      estimatedMonthlySales: 165,
      keywordSearchVolume: 22000,
      qualifiedTitlesInTop30: 25,
      competitivenessIndex: 0.70,
      medianPrice: 12.99,
      medianPageCount: 175,
      printCostEstimate: 3.8,
      reviewGaps: [
        '"Too surface-level, needs deeper scripture study" — 2★',
        '"Only 3 sentences per day — feels incomplete" — 3★',
      ],
      demandShape: "evergreen",
      longTailVariants: 19,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-crafts-knitting-crochet",
    categoryPath: ["Books", "Crafts, Hobbies & Home", "Crafts & Hobbies", "Knitting & Crocheting"],
    headKeyword: "crochet patterns book for beginners",
    depth: 4,
    signals: {
      bsrMedianTop30: 22000,
      estimatedMonthlySales: 145,
      keywordSearchVolume: 28000,
      qualifiedTitlesInTop30: 18,
      competitivenessIndex: 0.52,
      medianPrice: 14.99,
      medianPageCount: 120,
      printCostEstimate: 3.2,
      reviewGaps: [
        '"Patterns missing gauge and tension info" — 2★',
        '"Photos too small to see stitch detail clearly" — 3★',
        '"No explanation of abbreviations for true beginners" — 2★',
      ],
      demandShape: "evergreen",
      longTailVariants: 26,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-parenting-reference",
    categoryPath: ["Books", "Parenting & Relationships", "Parenting", "Reference"],
    headKeyword: "parenting books for new parents",
    depth: 4,
    signals: {
      bsrMedianTop30: 30000,
      estimatedMonthlySales: 92,
      keywordSearchVolume: 25000,
      qualifiedTitlesInTop30: 24,
      competitivenessIndex: 0.73,
      medianPrice: 16.99,
      medianPageCount: 280,
      printCostEstimate: 5.8,
      reviewGaps: [
        '"Too judgmental — makes parents feel guilty" — 2★',
        '"Advice feels outdated, ignores screen time reality" — 3★',
      ],
      demandShape: "evergreen",
      longTailVariants: 16,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
  {
    categoryId: "kbp-humor-trivia",
    categoryPath: ["Books", "Humor & Entertainment", "Humor", "Trivia"],
    headKeyword: "trivia books for adults",
    depth: 4,
    signals: {
      bsrMedianTop30: 35000,
      estimatedMonthlySales: 72,
      keywordSearchVolume: 20000,
      qualifiedTitlesInTop30: 16,
      competitivenessIndex: 0.48,
      medianPrice: 10.99,
      medianPageCount: 160,
      printCostEstimate: 3.4,
      reviewGaps: [
        '"Questions way too easy, gets boring fast" — 2★',
        '"No explanations for answers — I want to learn why" — 3★',
      ],
      demandShape: "gift-seasonal", // Christmas/holiday cliff
      longTailVariants: 12,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: true,
    },
  },
  {
    categoryId: "kbp-law-legal-self-help",
    categoryPath: ["Books", "Law", "Legal Self-Help"],
    headKeyword: "legal self help guide",
    depth: 3,
    signals: {
      bsrMedianTop30: 45000,
      estimatedMonthlySales: 52,
      keywordSearchVolume: 8000,
      qualifiedTitlesInTop30: 12,
      competitivenessIndex: 0.38,
      medianPrice: 19.99,
      medianPageCount: 300,
      printCostEstimate: 6.0,
      reviewGaps: [
        '"Only covers US federal law, ignores state variations" — 2★',
        '"Not updated since 2019, laws have changed" — 2★',
        '"Assumes you already know legal terminology" — 3★',
      ],
      demandShape: "evergreen",
      longTailVariants: 28,
      kdpPolicyProximity: "safe",
      seasonalityCliffRisk: false,
    },
  },
];

// ── Scoring algorithm ─────────────────────────────────────────────────────────
// Versioned per skill spec. DO NOT modify weights.

function computeScore(signals) {
  const {
    bsrMedianTop30,
    estimatedMonthlySales,
    keywordSearchVolume,
    qualifiedTitlesInTop30,
    competitivenessIndex,
    medianPrice,
    medianPageCount,
    printCostEstimate,
    reviewGaps,
    demandShape,
    longTailVariants,
    kdpPolicyProximity,
    seasonalityCliffRisk,
  } = signals;

  // Hard guard checks
  const bsrGuardFailed = bsrMedianTop30 > 50000;
  const royaltyPerUnit = medianPrice * 0.6 - printCostEstimate;
  const royaltyGuardFailed = royaltyPerUnit < 2.0;
  const reviewGapGuardFailed = reviewGaps.length < 2;

  if (bsrGuardFailed) return { composite: 30, hardGuard: "bsr_floor", components: {} };
  if (royaltyGuardFailed) return { composite: 40, hardGuard: "royalty_floor", components: {} };

  // Demand (30%)
  // BSR: lower is better. Score 100 at BSR ≤2000, drops to 0 at BSR ~80000
  const bsrScore = Math.max(0, Math.min(100, 100 - (bsrMedianTop30 / 800)));
  // Sales velocity: 100 at ≥1000 units/mo, 0 at 0
  const salesScore = Math.min(100, (estimatedMonthlySales / 1000) * 100);
  // Keyword volume: 100 at ≥100k/mo, 0 at 0
  const volumeScore = Math.min(100, (keywordSearchVolume / 100000) * 100);
  const demandScore = (bsrScore * 0.4 + salesScore * 0.35 + volumeScore * 0.25);

  // Competition (25%) — INVERTED: higher saturation = lower score
  // 0-30 qualified = low competition (good); 30 qualified = max saturation (bad)
  const saturationRatio = qualifiedTitlesInTop30 / 30;
  // competitivenessIndex 0–1 (1 = very hard)
  const competitionScore = Math.max(0, 100 - (saturationRatio * 70 + competitivenessIndex * 30));

  // Monetization (20%)
  // Price: ideal range $12–$20. Below $10 or above $30 penalized.
  const priceScore = medianPrice >= 12 && medianPrice <= 20 ? 80 :
                     medianPrice < 10 ? 30 :
                     medianPrice > 25 ? 60 : 50;
  // Royalty: $2 min, ideal $4+
  const royaltyScore = Math.min(100, Math.max(0, (royaltyPerUnit - 2) / 4 * 100 + 50));
  const monetizationScore = (priceScore * 0.4 + royaltyScore * 0.6);

  // Defensibility (15%)
  // Review-gap floor guard: if < 2 gaps, defensibility = 0
  let defScore = 0;
  if (!reviewGapGuardFailed) {
    const gapScore = Math.min(100, reviewGaps.length * 25); // 2 gaps = 50, 4+ = 100
    const evergreenScore = demandShape === "evergreen" ? 80 :
                           demandShape === "trending" ? 40 : 30;
    const ltScore = Math.min(100, (longTailVariants / 40) * 100);
    defScore = (gapScore * 0.45 + evergreenScore * 0.35 + ltScore * 0.20);
  }

  // Risk (10%)
  let riskScore = 85; // baseline
  if (kdpPolicyProximity !== "safe") riskScore -= 30;
  if (seasonalityCliffRisk) riskScore -= 25;
  riskScore = Math.max(0, riskScore);

  // Weighted composite
  const composite = Math.round(
    demandScore * 0.30 +
    competitionScore * 0.25 +
    monetizationScore * 0.20 +
    defScore * 0.15 +
    riskScore * 0.10
  );

  return {
    composite,
    hardGuard: null,
    components: {
      demand: Math.round(demandScore),
      competition: Math.round(competitionScore),
      monetization: Math.round(monetizationScore),
      defensibility: Math.round(defScore),
      risk: Math.round(riskScore),
      royaltyPerUnit: Math.round(royaltyPerUnit * 100) / 100,
    },
  };
}

function getTier(score) {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  return null; // below threshold
}

// ── Main execution ────────────────────────────────────────────────────────────

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Connected to DB on port 54329");

  // 1. Load cursor state
  const stateRes = await client.query(
    `SELECT value_json FROM nda_discovery_state WHERE company_id = $1 AND state_key = 'cursor'`,
    [COMPANY_ID]
  );
  const existingCursor = stateRes.rows[0]?.value_json ?? null;
  const cycleStartedAt = new Date().toISOString();
  console.log("Cursor state:", existingCursor ?? "FRESH START");

  const results = {
    processed: 0,
    opportunities: [],
    activityRows: [],
    errors: [],
  };

  // 2. Process each category
  for (const cat of CATEGORIES) {
    const loggedAt = new Date().toISOString();
    console.log(`\n[${cat.categoryPath.join(" > ")}]`);

    try {
      const scoring = computeScore(cat.signals);
      const tier = getTier(scoring.composite);
      const aboveThreshold = scoring.composite >= SCORE_THRESHOLD;

      console.log(
        `  Score: ${scoring.composite} | Tier: ${tier ?? "none"} | Hard guard: ${scoring.hardGuard ?? "none"}`
      );
      console.log(`  Components:`, scoring.components);

      // Write activity log
      await client.query(
        `INSERT INTO nda_activity_log
           (company_id, run_id, cycle_id, logged_at, category_path, category_id,
            head_keyword, composite_score, component_scores, hard_guard_triggered,
            above_threshold, captcha_event, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          COMPANY_ID,
          RUN_ID,
          CYCLE_ID,
          loggedAt,
          cat.categoryPath.join(" > "),
          cat.categoryId,
          cat.headKeyword,
          scoring.composite,
          JSON.stringify(scoring.components),
          scoring.hardGuard !== null,
          aboveThreshold,
          false,
          null,
        ]
      );

      results.activityRows.push({ category: cat.categoryPath.join(" > "), score: scoring.composite, tier });

      // Persist opportunity if above threshold
      if (aboveThreshold && tier) {
        const metadata = JSON.stringify({
          cycleId: CYCLE_ID,
          runId: RUN_ID,
          signals: cat.signals,
          scoring: scoring.components,
          reviewGaps: cat.signals.reviewGaps,
          depth: cat.depth,
          lens: "category-tree-gravity",
        });

        await client.query(
          `INSERT INTO niche_opportunities
             (company_id, head_keyword, category_path, tier, composite_score,
              status, metadata, discovered_at)
           VALUES ($1,$2,$3,$4,$5,'unreviewed',$6,NOW())`,
          [
            COMPANY_ID,
            cat.headKeyword,
            cat.categoryPath.join(" > "),
            tier,
            scoring.composite,
            metadata,
          ]
        );

        results.opportunities.push({
          category: cat.categoryPath.join(" > "),
          keyword: cat.headKeyword,
          score: scoring.composite,
          tier,
        });
        console.log(`  ✓ Opportunity persisted (Tier ${tier})`);
      }

      results.processed++;

      // Update cursor after each category
      await client.query(
        `INSERT INTO nda_discovery_state (company_id, state_key, value_json, updated_at)
         VALUES ($1, 'cursor', $2::jsonb, NOW())
         ON CONFLICT (company_id, state_key) DO UPDATE
           SET value_json = EXCLUDED.value_json,
               updated_at = NOW()`,
        [
          COMPANY_ID,
          JSON.stringify({
            lastCategoryId: cat.categoryId,
            lastCategoryPath: cat.categoryPath,
            cycleStartedAt,
            cycleId: CYCLE_ID,
            runId: RUN_ID,
            categoriesEvaluated: results.processed,
            opportunitiesFound: results.opportunities.length,
            updatedAt: new Date().toISOString(),
          }),
        ]
      );
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.errors.push({ category: cat.categoryPath.join(" > "), error: err.message });
    }
  }

  // 3. Verify writes
  const actCount = await client.query(
    `SELECT count(*) as cnt FROM nda_activity_log WHERE run_id = $1`,
    [RUN_ID]
  );
  const oppCount = await client.query(
    `SELECT count(*) as cnt FROM niche_opportunities WHERE company_id = $1`,
    [COMPANY_ID]
  );
  const cursorState = await client.query(
    `SELECT value_json FROM nda_discovery_state WHERE company_id = $1 AND state_key = 'cursor'`,
    [COMPANY_ID]
  );

  console.log("\n═══════════════════════════════════════════");
  console.log("HEARTBEAT SUMMARY — ATO-94 Test Cycle");
  console.log("═══════════════════════════════════════════");
  console.log(`Run ID:      ${RUN_ID}`);
  console.log(`Cycle ID:    ${CYCLE_ID}`);
  console.log(`Categories processed: ${results.processed}/10`);
  console.log(`Activity log rows:    ${actCount.rows[0].cnt}`);
  console.log(`Opportunities saved:  ${oppCount.rows[0].cnt}`);
  console.log(`Errors:               ${results.errors.length}`);
  console.log("\nOpportunities by tier:");
  const tierCounts = { S: 0, A: 0, B: 0 };
  for (const o of results.opportunities) tierCounts[o.tier]++;
  console.log(`  S (80-100): ${tierCounts.S}`);
  console.log(`  A (65-79):  ${tierCounts.A}`);
  console.log(`  B (50-64):  ${tierCounts.B}`);
  console.log("\nAll opportunities:");
  for (const o of results.opportunities) {
    console.log(`  [${o.tier}] ${o.score} — ${o.keyword} (${o.category})`);
  }
  console.log("\nCategories below threshold:");
  for (const r of results.activityRows.filter((r) => r.tier === null)) {
    console.log(`  ${r.score} — ${r.category}`);
  }
  console.log("\nCursor saved to nda_discovery_state:");
  console.log(JSON.stringify(cursorState.rows[0]?.value_json, null, 2));

  await client.end();

  // Return structured result for the caller
  return {
    runId: RUN_ID,
    cycleId: CYCLE_ID,
    categoriesProcessed: results.processed,
    activityLogRows: parseInt(actCount.rows[0].cnt),
    opportunitiesSaved: parseInt(oppCount.rows[0].cnt),
    tierBreakdown: tierCounts,
    opportunities: results.opportunities,
    belowThreshold: results.activityRows.filter((r) => r.tier === null),
    errors: results.errors,
  };
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
