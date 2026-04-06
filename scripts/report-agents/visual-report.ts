// visual-report.ts
// Generate dark-theme visual dashboard report → PNG → Telegram
// Usage: pnpm visual [daily|weekly|monthly]

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import Database from "better-sqlite3";
import { buildReportHtml, renderReportToPng, type ReportData } from "./lib/report-html.js";
import { sendPhoto } from "./lib/telegram.js";
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { execSync } from "child_process";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WHALES_DB_PATH = process.env.WHALES_DB_PATH!;
const SYNC_DIR = process.env.METABASE_SYNC_DIR || join(__dirname, "../../metabase-sync");
const period = process.argv[2] || "daily"; // daily | weekly | monthly

function getTimeRange(period: string) {
  switch (period) {
    case "weekly": return { sql: "datetime('now', '-7 days')", sqlPrev: "datetime('now', '-14 days')", label: "7 ngày", trendDays: 14 };
    case "monthly": return { sql: "datetime('now', 'start of month', '-1 month')", sqlPrev: "datetime('now', 'start of month', '-2 months')", label: "tháng trước", trendDays: 30 };
    default: return { sql: "datetime('now', '-24 hours')", sqlPrev: "datetime('now', '-48 hours')", label: "24h", trendDays: 14 };
  }
}

async function main() {
  console.log(`Visual Report: ${period}`);

  // Sync data
  console.log("  → Syncing...");
  try {
    execSync("node sync.mjs", { cwd: SYNC_DIR, timeout: 120_000, stdio: "pipe" });
  } catch { console.error("  → Sync failed"); }

  const range = getTimeRange(period);
  const db = new Database(WHALES_DB_PATH, { readonly: true });

  try {
    // Current period
    const current = db.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS total_orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS filled_volume,
        ROUND(SUM(CASE WHEN is_exit_position = 1 THEN order_value_usd_1side ELSE 0 END), 2) AS exit_volume,
        COUNT(DISTINCT buyer_id) + COUNT(DISTINCT seller_id) AS active_wallets
      FROM _order_flat WHERE created_at >= ${range.sql}
    `).get() as any;

    // Previous period
    const prev = db.prepare(`
      SELECT ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS filled_volume
      FROM _order_flat WHERE created_at >= ${range.sqlPrev} AND created_at < ${range.sql}
    `).get() as any;

    // Fees
    const filledVol = current.filled_volume || 0;
    const exitVol = current.exit_volume || 0;
    const totalFees = (filledVol - exitVol) * 0.025 + exitVol * 0.05;

    // Users
    const users = db.prepare(`
      WITH w AS (
        SELECT DISTINCT buyer_id AS user_id FROM _order_flat WHERE created_at >= ${range.sql}
        UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= ${range.sql}
      )
      SELECT
        COUNT(DISTINCT CASE WHEN ufo.first_order_at >= ${range.sql} THEN w.user_id END) AS new_users,
        COUNT(DISTINCT CASE WHEN ufo.first_order_at < ${range.sql} THEN w.user_id END) AS returning_users
      FROM w JOIN _user_first_order ufo ON w.user_id = ufo.user_id
    `).get() as any;

    // Top tokens
    const topTokens = db.prepare(`
      SELECT token_symbol AS symbol, chain_name AS chain,
        COUNT(DISTINCT order_id) AS orders,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS volume
      FROM _order_flat WHERE created_at >= ${range.sql}
      GROUP BY token_symbol, chain_name ORDER BY volume DESC LIMIT 7
    `).all() as any[];

    // Daily trend
    const dailyTrend = db.prepare(`
      SELECT DATE(created_at) AS date,
        ROUND(SUM(CASE WHEN is_exit_position = 0 THEN order_value_usd_1side ELSE 0 END), 2) AS volume,
        COUNT(DISTINCT order_id) AS orders
      FROM _order_flat WHERE created_at >= datetime('now', '-${range.trendDays} days')
      GROUP BY DATE(created_at) ORDER BY date
    `).all() as any[];

    // Settlement — overall
    const settle = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN status = 'close' AND is_exit_position = 0 THEN order_id END) AS settled,
        COUNT(DISTINCT CASE WHEN status = 'cancel' THEN order_id END) AS cancelled,
        COUNT(DISTINCT order_id) AS total
      FROM _order_flat WHERE created_at >= ${range.sql} AND status IN ('close', 'cancel')
    `).get() as any;

    // Settlement — per token
    const settleByToken = db.prepare(`
      SELECT
        token_symbol AS symbol,
        COUNT(DISTINCT CASE WHEN status = 'close' AND is_exit_position = 0 THEN order_id END) AS settled,
        COUNT(DISTINCT CASE WHEN status = 'cancel' THEN order_id END) AS cancelled,
        COUNT(DISTINCT order_id) AS total
      FROM _order_flat
      WHERE created_at >= ${range.sql} AND status IN ('close', 'cancel')
      GROUP BY token_symbol
      HAVING settled > 0 OR cancelled > 0
      ORDER BY total DESC
      LIMIT 10
    `).all().map((r: any) => ({
      symbol: r.symbol,
      settled: r.settled,
      cancelled: r.cancelled,
      total: r.total,
      rate: r.total > 0 ? (r.settled / r.total) * 100 : 0,
    }));

    // GA4
    let gaData: any = null;
    try {
      gaData = await fetchGA4Metrics();
    } catch (e) {
      console.error("  → GA4 failed:", (e as any).message?.slice(0, 50));
    }

    const now = new Date();
    const reportData: ReportData = {
      title: `Whales Market — ${period === "daily" ? "Daily" : period === "weekly" ? "Weekly" : "Monthly"} Report`,
      timeframe: period === "daily"
        ? now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })
        : period === "weekly"
        ? `${new Date(now.getTime() - 7 * 86400000).toLocaleDateString("vi-VN")} → ${now.toLocaleDateString("vi-VN")}`
        : `Tháng ${new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString("vi-VN", { month: "long", year: "numeric" })}`,
      totalOrders: current.total_orders || 0,
      filledVolume: current.filled_volume || 0,
      filledVolumePrev: prev?.filled_volume || 0,
      exitVolume: current.exit_volume || 0,
      totalFees: totalFees,
      activeWallets: current.active_wallets || 0,
      newUsers: users?.new_users || 0,
      returningUsers: users?.returning_users || 0,
      topTokens,
      dailyTrend,
      gaActiveUsers: gaData?.activeUsers,
      gaActiveUsersPrev: gaData ? gaData.activeUsers / (1 + gaData.activeUsersPctChange / 100) : undefined,
      gaSessions: gaData?.sessions,
      gaSessionsPrev: gaData ? gaData.sessions / (1 + gaData.sessionsPctChange / 100) : undefined,
      trafficSources: gaData?.trafficSources,
      topLandingPages: gaData?.topLandingPages,
      settledOrders: settle?.settled,
      cancelledOrders: settle?.cancelled,
      settleRate: settle?.total > 0 ? (settle.settled / settle.total) * 100 : undefined,
      settleByToken,
    };

    console.log("  → Building HTML...");
    const html = buildReportHtml(reportData);

    // Save HTML
    const htmlPath = `/tmp/whales-report-${period}.html`;
    fs.writeFileSync(htmlPath, html);
    console.log(`  → HTML saved: ${htmlPath}`);

    console.log("  → Rendering PNG...");
    const png = await renderReportToPng(html);

    const pngPath = `/tmp/whales-report-${period}.png`;
    fs.writeFileSync(pngPath, png);
    console.log(`  → PNG saved: ${pngPath}`);

    console.log("  → Sending to Telegram...");
    await sendPhoto(png, `📊 Whales Market ${period.charAt(0).toUpperCase() + period.slice(1)} Report — ${reportData.timeframe}`);

    // Generate insight text via Claude CLI
    console.log("  → Generating insight...");
    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);

      const insightPrompt = `Bạn là Head of Data Analytics cho Whales Market. Dựa trên data dưới đây, viết TỐI ĐA 5 bullet points insight ngắn gọn.

ĐỌC: ${SYNC_DIR}/BUSINESS_CONTEXT.md để biết benchmarks.

## Data (${period} report):
- Filled Volume: $${reportData.filledVolume.toFixed(0)} (prev: $${reportData.filledVolumePrev.toFixed(0)})
- Orders: ${reportData.totalOrders}
- Exit Position Volume: $${reportData.exitVolume.toFixed(0)}
- Active Wallets: ${reportData.activeWallets} (New: ${reportData.newUsers}, Returning: ${reportData.returningUsers})
- Fees: $${reportData.totalFees.toFixed(0)}
- Top tokens: ${reportData.topTokens.slice(0, 3).map(t => `$${t.symbol} ($${t.volume.toFixed(0)})`).join(", ")}
- Settlement: ${(reportData.settleByToken ?? []).length > 0 ? reportData.settleByToken!.map(t => `$${t.symbol}: ${t.rate.toFixed(0)}%`).join(", ") : "không có token settle"}
- GA4: Active Users ${reportData.gaActiveUsers ?? "N/A"}, Sessions ${reportData.gaSessions ?? "N/A"}
- Traffic: ${(reportData.trafficSources ?? []).map(s => `${s.source}(${s.sessions})`).join(", ")}
- Top landing pages: ${(reportData.topLandingPages ?? []).slice(0, 3).map(p => p.page.replace("/en/premarket/", "$")).join(", ")}

QUY TẮC:
- Viết tiếng Việt, metric giữ tiếng Anh
- Tối đa 5 bullet points, mỗi cái 1-2 dòng
- CHỈ dựa trên fact, so sánh với benchmark
- Nếu volume = 0 hoặc không có data → ghi rõ, không bịa
- Cross-platform insight nếu có (vd: token hot trên platform match với page views)
- Format HTML cho Telegram (<b>, <i>), KHÔNG markdown
- Bắt đầu bằng: <b>💡 Insight — ${reportData.timeframe}</b>`;

      const { stdout } = await execFileAsync("claude", [
        "--print", "--dangerously-skip-permissions",
        "--model", "claude-sonnet-4-5-20250929",
        "-p", insightPrompt,
      ], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
      });

      const insight = stdout.trim();
      if (insight) {
        const { sendTelegram } = await import("./lib/telegram.js");
        await sendTelegram(insight);
      }
    } catch (e) {
      console.error("  Insight error:", e);
    }

    console.log("Visual Report: done ✓");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Visual Report failed:", err);
  process.exit(1);
});
