// report-manager.ts
// Orchestrator: collect all data → analyze → generate daily/weekly/monthly reports

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { execFile } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import { sendTelegram } from "./lib/telegram.js";
import { fetchPlatformMetrics } from "./lib/metabase-queries.js";
import { buildPlatformHtml } from "./lib/platform-format.js";
import { runSocialCollector } from "./lib/social-format.js";
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

const execFileAsync = promisify(execFile);

const WHALES_DB_PATH = process.env.WHALES_DB_PATH!;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SOCIAL_ACCOUNTS = process.env.SOCIAL_ACCOUNTS ? JSON.parse(process.env.SOCIAL_ACCOUNTS) : [];

// ============================================================
// DATA COLLECTORS — orchestrated by manager
// ============================================================

async function collectPlatformData(): Promise<{ html: string; raw: any }> {
  const tokens = fetchPlatformMetrics(WHALES_DB_PATH);
  return {
    html: tokens.length > 0 ? buildPlatformHtml(tokens) : "🐳 Platform: Không có data 24h",
    raw: tokens,
  };
}

async function collectSocialData(): Promise<{ html: string | null; raw: any }> {
  if (!RAPIDAPI_KEY || SOCIAL_ACCOUNTS.length === 0) return { html: null, raw: null };
  const html = await runSocialCollector(RAPIDAPI_KEY, SOCIAL_ACCOUNTS);
  return { html, raw: SOCIAL_ACCOUNTS };
}

async function collectGA4Data(): Promise<{ html: string; raw: any }> {
  if (!process.env.GA4_PROPERTY_ID) return { html: "🌐 GA4: Chưa config", raw: null };
  const m = await fetchGA4Metrics();
  const lines = [
    `<b>🌐 Whales Market — Website Daily Report</b>\n`,
    `👥 Active Users: <b>${moneySmart(m.activeUsers, "")}</b> (${growthBadge(m.activeUsersPctChange)})`,
    `🆕 New Users: <b>${moneySmart(m.newUsers, "")}</b> (${growthBadge(m.newUsersPctChange)})`,
    `📊 Sessions: <b>${moneySmart(m.sessions, "")}</b> (${growthBadge(m.sessionsPctChange)})`,
  ];
  const premarketPages = m.topLandingPages
    .filter((p: any) => /^\/en\/premarket\//.test(p.page))
    .slice(0, 3);
  if (premarketPages.length > 0) {
    lines.push(`\n🚪 <b>Top Pre-Market Landing Pages:</b>`);
    premarketPages.forEach((p: any) => {
      const token = p.page.replace("/en/premarket/", "");
      lines.push(`  $${token} — ${p.sessions} sessions`);
    });
  }
  return { html: lines.join("\n"), raw: m };
}

// ============================================================
// PERIOD DB QUERIES
// ============================================================

function queryPeriodData(dbPath: string, startSql: string, endSql: string, prevStartSql: string, prevEndSql: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const overview = db.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS total_orders,
        COUNT(DISTINCT CASE WHEN is_exit_position = 0 THEN order_id END) AS filled_orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS filled_volume_1side,
        ROUND(SUM(CASE WHEN is_exit_position = 1 THEN order_value_usd_1side ELSE 0 END), 2) AS exit_volume,
        COUNT(DISTINCT token_symbol) AS active_tokens,
        COUNT(DISTINCT buyer_id) AS unique_buyers,
        COUNT(DISTINCT seller_id) AS unique_sellers
      FROM _order_flat
      WHERE created_at >= ${startSql} AND created_at < ${endSql}
    `).get();

    const prevOverview = db.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS total_orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS filled_volume_1side
      FROM _order_flat
      WHERE created_at >= ${prevStartSql} AND created_at < ${prevEndSql}
    `).get();

    const topTokens = db.prepare(`
      SELECT token_symbol, chain_name,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS volume_usd,
        COUNT(DISTINCT buyer_id) AS buyers,
        COUNT(DISTINCT seller_id) AS sellers
      FROM _order_flat
      WHERE created_at >= ${startSql} AND created_at < ${endSql}
      GROUP BY token_symbol, chain_name
      ORDER BY volume_usd DESC LIMIT 10
    `).all();

    const userMetrics = db.prepare(`
      WITH period_users AS (
        SELECT DISTINCT buyer_id AS user_id FROM _order_flat WHERE created_at >= ${startSql} AND created_at < ${endSql}
        UNION
        SELECT DISTINCT seller_id AS user_id FROM _order_flat WHERE created_at >= ${startSql} AND created_at < ${endSql}
      )
      SELECT
        COUNT(DISTINCT pu.user_id) AS total_active,
        COUNT(DISTINCT CASE WHEN ufo.first_order_at >= ${startSql} THEN pu.user_id END) AS new_users,
        COUNT(DISTINCT CASE WHEN ufo.first_order_at < ${startSql} THEN pu.user_id END) AS returning_users
      FROM period_users pu
      JOIN _user_first_order ufo ON pu.user_id = ufo.user_id
    `).get();

    const settlePerf = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN status = 'close' AND is_exit_position = 0 THEN order_id END) AS settled,
        COUNT(DISTINCT CASE WHEN status = 'cancel' THEN order_id END) AS cancelled,
        COUNT(DISTINCT order_id) AS total
      FROM _order_flat
      WHERE created_at >= ${startSql} AND created_at < ${endSql} AND status IN ('close', 'cancel')
    `).get();

    const weeklyBreakdown = db.prepare(`
      SELECT
        CASE
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 7 THEN 'Week 1'
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 14 THEN 'Week 2'
          WHEN CAST(strftime('%d', created_at) AS INTEGER) <= 21 THEN 'Week 3'
          ELSE 'Week 4'
        END AS week,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS volume_usd
      FROM _order_flat
      WHERE created_at >= ${startSql} AND created_at < ${endSql}
      GROUP BY week ORDER BY week
    `).all();

    const topChains = db.prepare(`
      SELECT chain_name, COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS volume_usd
      FROM _order_flat
      WHERE created_at >= ${startSql} AND created_at < ${endSql} AND chain_name IS NOT NULL
      GROUP BY chain_name ORDER BY volume_usd DESC LIMIT 5
    `).all();

    return JSON.stringify({ overview, prevOverview, topTokens, userMetrics, settlePerf, weeklyBreakdown, topChains }, null, 2);
  } finally {
    db.close();
  }
}

// ============================================================
// CLAUDE CLI — analyze + format
// ============================================================

async function claudeAnalyze(prompt: string): Promise<string> {
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
  return stdout.trim();
}

const REPORT_RULES = `ĐỌC FILE NÀY TRƯỚC: /Users/amando/Desktop/Learn/metabase-sync/BUSINESS_CONTEXT.md — chứa KPIs, benchmarks, mục tiêu, cách đánh giá tốt/xấu.

QUY TẮC BẮT BUỘC:
- Viết tiếng Việt, giữ nguyên tiếng Anh cho metric: Volume, Order, Settlement Rate, Active Users, Sessions, Exit Position, New Users, Returning Users, MoM, WoW, Acquisition Rate, etc.
- Chỉ dùng HTML tags (<b>, <i>), KHÔNG dùng markdown
- Mỗi metric kèm giải thích ngắn gọn cho người không chuyên hiểu
- So sánh với benchmarks trong BUSINESS_CONTEXT.md để đánh giá (Tệ/TB/Tốt/Rất tốt)
- Phân biệt rõ: Fact (số liệu) → Observation (pattern) → Recommendation (đề xuất)
- CHỈ nói dựa trên dữ liệu thực, KHÔNG suy đoán hay bịa số
- Nếu không đủ dữ liệu → ghi rõ "chưa đủ dữ liệu"
- Giữ dưới 3500 ký tự`;

// ============================================================
// REPORT GENERATORS
// ============================================================

async function generateDailyInsight(platformRaw: any, gaRaw: any): Promise<string> {
  const today = new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const prompt = `Bạn là data analyst cho Whales Market. Viết daily insight ngắn gọn.

## Platform Data (24h):
${JSON.stringify(platformRaw?.slice(0, 5), null, 2)}

## GA4 Data (yesterday):
${JSON.stringify(gaRaw, null, 2)}

Viết phần <b>💡 Daily Insight — ${today}</b> dưới 500 ký tự:
- 2-3 điểm đáng chú ý nhất hôm nay dựa trên cả platform + website data
- So sánh cross-platform nếu có pattern thú vị (vd: token hot trên platform cũng có nhiều page views?)
- Ngắn gọn, dựa trên fact

${REPORT_RULES}`;
  return claudeAnalyze(prompt);
}

async function generateWeeklyReport(): Promise<string> {
  const data = queryPeriodData(WHALES_DB_PATH,
    "datetime('now', '-7 days')", "datetime('now')",
    "datetime('now', '-14 days')", "datetime('now', '-7 days')");

  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86400000).toLocaleDateString("vi-VN");
  const weekEnd = now.toLocaleDateString("vi-VN");

  const prompt = `Bạn là senior data analyst cho Whales Market (nền tảng pre-market trading).

## Dữ liệu Trading (7 ngày qua):
${data}

Viết báo cáo tuần HTML cho Telegram:

<b>📊 Whales Market — Báo Cáo Tuần</b>
<b>Timeframe: ${weekStart} - ${weekEnd}</b>

<b>1. Tổng Quan</b> - Highlights, so sánh WoW (Week over Week = so với tuần trước)

<b>2. Trading Performance</b>
- Filled Order Volume (tổng giá trị lệnh khớp, không tính Exit Position/resale), WoW %
- Top 5 tokens kèm context
- Settlement Rate (% đơn giao token thành công sau TGE)

<b>3. Người Dùng</b>
- New Users (ví lần đầu giao dịch) vs Returning Users (ví đã từng giao dịch)
- Acquisition Rate (% người mới / tổng active)

<b>4. Nhận Định</b> - 2-3 insights dựa trên số liệu, xu hướng đáng chú ý

${REPORT_RULES}`;
  return claudeAnalyze(prompt);
}

async function generateMonthlyReport(): Promise<string> {
  const data = queryPeriodData(WHALES_DB_PATH,
    "datetime('now', 'start of month', '-1 month')", "datetime('now', 'start of month')",
    "datetime('now', 'start of month', '-2 months')", "datetime('now', 'start of month', '-1 month')");

  let gaData = "Không có";
  if (process.env.GA4_PROPERTY_ID) {
    try {
      const { fetchGA4MonthlyMetrics } = await import("./lib/ga4-monthly.js");
      gaData = JSON.stringify(await fetchGA4MonthlyMetrics(), null, 2);
    } catch (e) { console.error("  GA4 monthly error:", e); }
  }

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthName = lastMonth.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
  const startDate = lastMonth.toLocaleDateString("vi-VN");
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0).toLocaleDateString("vi-VN");

  const prompt = `Bạn là senior crypto/DeFi analyst viết báo cáo tháng cho team Whales Market.

## Dữ liệu Trading Platform:
${data}

## Dữ liệu Website (GA4):
${gaData}

Viết báo cáo tháng HTML cho Telegram:

<b>📊 Whales Market — Báo Cáo Tháng</b>
<b>Timeframe: Tháng ${monthName} (${startDate} - ${endDate})</b>

<b>1. Tổng Quan</b> - Highlights và sức khỏe platform

<b>2. Hiệu Suất Trading</b>
- Filled Order Volume (tổng giá trị lệnh khớp, không tính Exit Position), MoM %
- Top 3 tokens + context vì sao hot
- Settlement Rate (% đơn giao token thành công)
- Exit Position Volume (giá trị resale — bán lại vị thế trước TGE) — nêu riêng

<b>3. Người Dùng</b>
- New Users vs Returning Users, Acquisition Rate
- Đánh giá chất lượng tăng trưởng

<b>4. Website & Traffic</b>
- Active Users, Sessions, MoM
- Top countries, traffic sources, pre-market landing pages hot

<b>5. Xu Hướng Theo Tuần</b> - Tuần nào mạnh/yếu nhất, có pattern gì

<b>6. Nhận Định & Đề Xuất</b>
- 3-5 nhận định DỰA TRÊN SỐ LIỆU (vd: "Volume giảm 20% nhưng New Users tăng 15% → traffic mới chưa convert")
- Đề xuất hành động cụ thể

${REPORT_RULES}`;
  return claudeAnalyze(prompt);
}

// ============================================================
// MAIN — orchestrate
// ============================================================

async function sendLongMessage(text: string) {
  if (text.length > 4000) {
    const mid = text.lastIndexOf("\n", 2000);
    await sendTelegram(text.slice(0, mid));
    await sendTelegram(text.slice(mid));
  } else {
    await sendTelegram(text);
  }
}

async function main() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const dayOfMonth = now.getDate();

  console.log(`Report Manager: ${now.toISOString()}`);
  console.log(`  Day of week: ${dayOfWeek} (0=Sun), Day of month: ${dayOfMonth}`);

  // === SYNC DATA FIRST ===
  console.log("\n  → Syncing data...");
  try {
    const { execSync } = await import("child_process");
    execSync("node sync.mjs", { cwd: "/Users/amando/Desktop/Learn/metabase-sync", timeout: 120_000, stdio: "pipe" });
    console.log("  → Sync done ✓");
  } catch (e) {
    console.error("  → Sync failed (continuing with existing data)");
  }

  // === DAILY (always) ===
  console.log("\n=== DAILY REPORT ===");

  console.log("  → Platform...");
  const platform = await collectPlatformData();

  console.log("  → Social...");
  const social = await collectSocialData();

  console.log("  → GA4...");
  let ga: { html: string; raw: any } = { html: "", raw: null };
  try {
    ga = await collectGA4Data();
  } catch (e) {
    console.error("  GA4 failed (continuing without):", e);
    ga = { html: "🌐 GA4: Credentials hết hạn — cần chạy `gcloud auth application-default login`", raw: null };
  }

  // Send individual data reports
  if (platform.html) await sendTelegram(platform.html);
  if (social.html) await sendTelegram(social.html);
  if (ga.html) await sendTelegram(ga.html);

  // Daily insight (cross-platform analysis by Claude)
  console.log("  → Daily insight...");
  try {
    const insight = await generateDailyInsight(platform.raw, ga.raw);
    if (insight) await sendTelegram(insight);
  } catch (e) { console.error("  Daily insight error:", e); }

  // === WEEKLY (Sunday) ===
  if (dayOfWeek === 0) {
    console.log("\n=== WEEKLY REPORT ===");
    try {
      await sendLongMessage(await generateWeeklyReport());
    } catch (e) {
      console.error("  Weekly error:", e);
      await sendTelegram(`❌ Weekly report failed: ${String(e).slice(0, 200)}`);
    }
  }

  // === MONTHLY (1st) ===
  if (dayOfMonth === 1) {
    console.log("\n=== MONTHLY REPORT ===");
    try {
      await sendLongMessage(await generateMonthlyReport());
    } catch (e) {
      console.error("  Monthly error:", e);
      await sendTelegram(`❌ Monthly report failed: ${String(e).slice(0, 200)}`);
    }
  }

  console.log("\nReport Manager: done ✓");
}

main().catch((err) => {
  console.error("Report Manager failed:", err);
  process.exit(1);
});
