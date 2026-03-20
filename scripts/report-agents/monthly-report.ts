// monthly-report.ts
// Collect all platform data for the past month → Claude CLI analyze → Telegram
// Env: WHALES_DB_PATH, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GA4_PROPERTY_ID, RAPIDAPI_KEY, SOCIAL_ACCOUNTS

import Database from "better-sqlite3";
import { execFile } from "child_process";
import { promisify } from "util";
import { sendTelegram } from "./lib/telegram.js";
import { fetchGA4MonthlyMetrics } from "./lib/ga4-monthly.js";

const execFileAsync = promisify(execFile);

const WHALES_DB_PATH = process.env.WHALES_DB_PATH;
if (!WHALES_DB_PATH) throw new Error("Missing WHALES_DB_PATH");

// --- 1. Platform metrics (from SQLite) ---
function getPlatformMonthlyData(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Overview
    const overview = db.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS total_orders,
        COUNT(DISTINCT CASE WHEN is_exit_position = 0 THEN order_id END) AS filled_orders_excl_exit,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS filled_order_volume_1side,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END) * 2, 2) AS filled_order_volume_2side,
        ROUND(SUM(CASE WHEN is_exit_position = 1 THEN order_value_usd_1side ELSE 0 END), 2) AS exit_position_volume,
        COUNT(DISTINCT token_symbol) AS active_tokens,
        COUNT(DISTINCT buyer_id) + COUNT(DISTINCT seller_id) AS unique_wallets
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-1 month')
        AND created_at < datetime('now', 'start of month')
    `).get() as any;

    // Previous month for comparison
    const prevOverview = db.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS total_orders,
        ROUND(SUM(order_value_usd_1side), 2) AS total_order_volume_1side
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-2 months')
        AND created_at < datetime('now', 'start of month', '-1 month')
    `).get() as any;

    // Top 10 tokens by volume
    const topTokens = db.prepare(`
      SELECT
        token_symbol,
        chain_name,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(order_value_usd_1side), 2) AS volume_usd,
        COUNT(DISTINCT buyer_id) AS unique_buyers,
        COUNT(DISTINCT seller_id) AS unique_sellers
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-1 month')
        AND created_at < datetime('now', 'start of month')
      GROUP BY token_symbol, chain_name
      ORDER BY volume_usd DESC
      LIMIT 10
    `).all();

    // New vs returning users
    const userMetrics = db.prepare(`
      WITH month_users AS (
        SELECT DISTINCT buyer_id AS user_id FROM _order_flat
        WHERE created_at >= datetime('now', 'start of month', '-1 month')
          AND created_at < datetime('now', 'start of month')
        UNION
        SELECT DISTINCT seller_id AS user_id FROM _order_flat
        WHERE created_at >= datetime('now', 'start of month', '-1 month')
          AND created_at < datetime('now', 'start of month')
      )
      SELECT
        COUNT(DISTINCT mu.user_id) AS total_active,
        COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now', 'start of month', '-1 month') THEN mu.user_id END) AS new_users,
        COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now', 'start of month', '-1 month') THEN mu.user_id END) AS returning_users
      FROM month_users mu
      JOIN _user_first_order ufo ON mu.user_id = ufo.user_id
    `).get() as any;

    // Weekly breakdown
    const weeklyBreakdown = db.prepare(`
      SELECT
        CASE
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 7 THEN 'Week 1'
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 14 THEN 'Week 2'
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 21 THEN 'Week 3'
          ELSE 'Week 4'
        END AS week,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(order_value_usd_1side), 2) AS volume_usd
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-1 month')
        AND created_at < datetime('now', 'start of month')
      GROUP BY week
      ORDER BY week
    `).all();

    // Settle performance
    const settlePerf = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN status = 'close' AND is_exit_position = 0 THEN order_id END) AS settled,
        COUNT(DISTINCT CASE WHEN status = 'cancel' THEN order_id END) AS cancelled,
        COUNT(DISTINCT order_id) AS total
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-1 month')
        AND created_at < datetime('now', 'start of month')
        AND status IN ('close', 'cancel')
    `).get() as any;

    // Exit positions (resale)
    const exitPos = db.prepare(`
      SELECT
        COUNT(*) AS total_exit_offers,
        ROUND(SUM(o.value * et.price), 2) AS total_exit_value_usd
      FROM offer o
      JOIN token et ON o.ex_token_id = et.id
      WHERE o.is_exit_position = 1
        AND o.deleted_at IS NULL
        AND o.created_at >= datetime('now', 'start of month', '-1 month')
        AND o.created_at < datetime('now', 'start of month')
    `).get() as any;

    // Top chains
    const topChains = db.prepare(`
      SELECT
        chain_name,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(order_value_usd_1side), 2) AS volume_usd
      FROM _order_flat
      WHERE created_at >= datetime('now', 'start of month', '-1 month')
        AND created_at < datetime('now', 'start of month')
        AND chain_name IS NOT NULL
      GROUP BY chain_name
      ORDER BY volume_usd DESC
      LIMIT 5
    `).all();

    return JSON.stringify({
      period: "last_month",
      overview,
      prevOverview,
      topTokens,
      userMetrics,
      weeklyBreakdown,
      settlePerf,
      exitPos,
      topChains,
    }, null, 2);
  } finally {
    db.close();
  }
}

// --- Main ---
async function main() {
  console.log("Monthly Report: collecting data...");

  // 1. Platform data
  console.log("  → Platform metrics...");
  const platformData = getPlatformMonthlyData(WHALES_DB_PATH!);

  // 2. GA4 data
  let gaData = "GA4 data not available";
  if (process.env.GA4_PROPERTY_ID) {
    try {
      console.log("  → GA4 metrics...");
      const ga = await fetchGA4MonthlyMetrics();
      gaData = JSON.stringify(ga, null, 2);
    } catch (e) {
      console.error("  → GA4 error:", e);
    }
  }

  // 3. Feed to Claude CLI for analysis
  console.log("  → Claude analyzing...");

  const prompt = `You are a senior crypto/DeFi analyst writing a monthly report for the Whales Market team (pre-market trading platform).

## Platform Trading Data (from database):
${platformData}

## Website Analytics (from GA4):
${gaData}

Write a comprehensive monthly report in HTML format for Telegram. Structure:

<b>📊 Whales Market — Monthly Report</b>

<b>1. Executive Summary</b>
- 2-3 bullet points: key highlights and overall health

<b>2. Trading Performance</b>
- Total volume (MoM change %)
- Order count and avg order size
- Top 3 tokens by volume with brief context
- Settlement rate and what it means

<b>3. User Growth</b>
- New vs returning users ratio
- Acquisition quality assessment
- Notable trends

<b>4. Website & Traffic</b>
- Key GA4 metrics and what they indicate
- Traffic quality assessment

<b>5. Weekly Trend</b>
- Which weeks were strongest/weakest and why

<b>6. Key Insights & Recommendations</b>
- 3-5 actionable insights based on cross-platform data
- What's working, what needs attention
- Growth opportunities

Rules:
- Use HTML tags only (<b>, <i>, <u>), no markdown
- Use emoji sparingly for section headers
- Be specific with numbers, percentages, comparisons
- Write insights like a real analyst — not just data recitation
- Keep total length under 3000 chars (Telegram limit)
- Language: English with key terms`;

  try {
    const { stdout } = await execFileAsync("claude", [
      "--print",
      "--dangerously-skip-permissions",
      "--model", "claude-sonnet-4-5-20250929",
      "-p", prompt,
    ], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    });

    const report = stdout.trim();
    if (!report) throw new Error("Empty response from Claude");

    // Telegram has 4096 char limit per message — split if needed
    if (report.length > 4000) {
      const mid = report.lastIndexOf("\n", 2000);
      const part1 = report.slice(0, mid);
      const part2 = report.slice(mid);
      console.log("Monthly Report: sending to Telegram (2 parts)...");
      await sendTelegram(part1);
      await sendTelegram(part2);
    } else {
      console.log("Monthly Report: sending to Telegram...");
      await sendTelegram(report);
    }

    console.log("Monthly Report: done ✓");
  } catch (e: any) {
    console.error("Monthly Report: Claude error:", e.message);
    // Fallback: send raw data summary
    await sendTelegram(`❌ Monthly report generation failed: ${e.message?.slice(0, 200)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Monthly Report failed:", err);
  process.exit(1);
});
