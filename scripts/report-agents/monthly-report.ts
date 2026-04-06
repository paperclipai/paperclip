// monthly-report.ts
// Collect all platform data for the past month → Claude CLI analyze → Telegram

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

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

  // Calculate timeframe label
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthName = lastMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const startDate = lastMonth.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });

  const prompt = `Bạn là senior crypto/DeFi analyst viết báo cáo tháng cho team Whales Market (nền tảng pre-market trading).

## Dữ liệu Trading Platform (từ database):
${platformData}

## Dữ liệu Website (từ GA4):
${gaData}

Viết báo cáo tháng bằng HTML cho Telegram. Cấu trúc:

<b>📊 Whales Market — Báo Cáo Tháng</b>
<b>Timeframe: ${monthName} (${startDate} - ${endDate})</b>

<b>1. Tổng Quan</b>
- 2-3 điểm chính nổi bật nhất tháng vừa rồi
- Đánh giá sức khỏe tổng thể của platform

<b>2. Hiệu Suất Trading</b>
- Total Order Volume (không tính exit position/resale) so với tháng trước (MoM %)
- Giải thích: Order Volume = tổng giá trị các lệnh được khớp trên platform
- Số lượng Orders và avg order size (trung bình mỗi lệnh bao nhiêu USD)
- Top 3 tokens có volume lớn nhất — mỗi token giải thích ngắn gọn vì sao hot
- Settlement Rate = % đơn hàng được giao token thành công sau TGE. Nêu con số và đánh giá tốt hay xấu
- Exit Position Volume (resale) = giá trị các lệnh resale (bán lại vị thế trước khi token ra mắt). Nêu riêng biệt

<b>3. Người Dùng</b>
- New Users vs Returning Users — bao nhiêu người mới, bao nhiêu quay lại
- Giải thích: New User = ví lần đầu giao dịch trên platform trong tháng này
- Acquisition Rate = New Users / Total Active Users (%)
- Đánh giá chất lượng tăng trưởng

<b>4. Website & Traffic (GA4)</b>
- Active Users, Sessions — so sánh MoM
- Giải thích: Active Users = số người truy cập website, Sessions = số phiên truy cập
- Top countries & traffic sources — traffic đến từ đâu
- Top pre-market landing pages — token page nào được xem nhiều nhất

<b>5. Xu Hướng Theo Tuần</b>
- Tuần nào mạnh nhất / yếu nhất trong tháng
- Có pattern gì đáng chú ý không

<b>6. Nhận Định & Đề Xuất</b>
- 3-5 nhận định DỰA TRÊN SỐ LIỆU (không suy đoán)
- Mỗi nhận định phải có số liệu đi kèm
- Đề xuất hành động cụ thể

QUY TẮC BẮT BUỘC:
- Viết tiếng Việt, giữ nguyên tiếng Anh cho các metric/thuật ngữ: Volume, Order, Settlement Rate, Active Users, Sessions, Bounce Rate, Exit Position, New Users, Returning Users, MoM, Acquisition Rate, etc.
- Chỉ dùng HTML tags (<b>, <i>), KHÔNG dùng markdown
- Mỗi metric phải kèm giải thích ngắn gọn giúp ai cũng hiểu (vd: "Settlement Rate (% đơn được giao thành công): 85%")
- CHỈ nói dựa trên dữ liệu thực, KHÔNG suy đoán hay bịa số
- Nếu dữ liệu không đủ để kết luận, ghi rõ "chưa đủ dữ liệu"
- Giữ dưới 3500 ký tự (giới hạn Telegram)`;

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
