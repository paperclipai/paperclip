import Database from "better-sqlite3";
import { moneySmart } from "./formatters.js";

export interface WeeklyAnalysis {
  // Period
  startDate: string;
  endDate: string;
  // Core metrics
  totalVolumeOnWeb: number;
  filledVolume: number;
  fillRate: number;
  totalOrders: number;
  // Users
  totalUsers: number;
  newUsers: number;
  oldUsers: number;
  // WoW comparison
  prevFilledVolume: number;
  prevTotalOrders: number;
  prevTotalUsers: number;
  prevNewUsers: number;
  prevOldUsers: number;
  prevVolumeOnWeb: number;
  // Top tokens
  topTokens: Array<{
    symbol: string;
    filledVolume: number;
    orders: number;
    newWallets: number;
    oldWallets: number;
    volumeOnWeb: number;
  }>;
  // Daily breakdown
  dailyVolume: Array<{ day: string; volume: number; orders: number }>;
  // Fees
  feesTotal: number;
}

export function analyzeWeekly(dbPath: string): WeeklyAnalysis {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Current week = last 7 days, previous week = 7-14 days ago
    const startDate = db.prepare(`SELECT DATE('now', '-7 days') AS d`).get() as any;
    const endDate = db.prepare(`SELECT DATE('now') AS d`).get() as any;
    const start = startDate.d;
    const end = endDate.d;

    // Current week filled volume & orders (2-sided)
    const current = db.prepare(`
      SELECT
        ROUND(SUM(order_value_usd) * 2, 2) AS filled_volume,
        COUNT(*) AS total_orders
      FROM _order_flat
      WHERE created_at >= datetime('now', '-7 days')
    `).get() as any;

    // Previous week
    const prev = db.prepare(`
      SELECT
        ROUND(SUM(order_value_usd) * 2, 2) AS filled_volume,
        COUNT(*) AS total_orders
      FROM _order_flat
      WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')
    `).get() as any;

    // Volume on web (from offers created this week)
    const webVol = db.prepare(`
      SELECT ROUND(SUM(value), 2) AS vol
      FROM offer
      WHERE created_at >= datetime('now', '-7 days') AND deleted_at IS NULL
    `).get() as any;

    const prevWebVol = db.prepare(`
      SELECT ROUND(SUM(value), 2) AS vol
      FROM offer
      WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') AND deleted_at IS NULL
    `).get() as any;

    // Users this week (new vs old)
    const users = db.prepare(`
      WITH week_users AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now', '-7 days')
        UNION
        SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= datetime('now', '-7 days')
      ),
      classified AS (
        SELECT wu.uid,
          CASE WHEN EXISTS (
            SELECT 1 FROM _order_flat o2
            WHERE (o2.buyer_id = wu.uid OR o2.seller_id = wu.uid)
              AND o2.created_at < datetime('now', '-7 days')
          ) THEN 'Old' ELSE 'New' END AS user_type
        FROM week_users wu
      )
      SELECT user_type, COUNT(*) AS count FROM classified GROUP BY user_type
    `).all() as any[];

    const newRow = users.find((u: any) => u.user_type === "New") || { count: 0 };
    const oldRow = users.find((u: any) => u.user_type === "Old") || { count: 0 };

    // Previous week users
    const prevUsers = db.prepare(`
      WITH week_users AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')
        UNION
        SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')
      ),
      classified AS (
        SELECT wu.uid,
          CASE WHEN EXISTS (
            SELECT 1 FROM _order_flat o2
            WHERE (o2.buyer_id = wu.uid OR o2.seller_id = wu.uid)
              AND o2.created_at < datetime('now', '-14 days')
          ) THEN 'Old' ELSE 'New' END AS user_type
        FROM week_users wu
      )
      SELECT user_type, COUNT(*) AS count FROM classified GROUP BY user_type
    `).all() as any[];

    const prevNewRow = prevUsers.find((u: any) => u.user_type === "New") || { count: 0 };
    const prevOldRow = prevUsers.find((u: any) => u.user_type === "Old") || { count: 0 };

    // Top tokens this week (2-sided)
    const topTokens = db.prepare(`
      SELECT
        token_symbol AS symbol,
        ROUND(SUM(order_value_usd) * 2, 0) AS filled_volume,
        COUNT(*) AS orders,
        COUNT(DISTINCT CASE WHEN NOT EXISTS (
          SELECT 1 FROM _order_flat o2
          WHERE (o2.buyer_id = o.buyer_id OR o2.seller_id = o.buyer_id)
            AND o2.created_at < datetime('now', '-7 days')
        ) THEN o.buyer_id END) AS new_wallets,
        COUNT(DISTINCT o.buyer_id) + COUNT(DISTINCT o.seller_id) AS total_wallets
      FROM _order_flat o
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY token_symbol
      ORDER BY filled_volume DESC
      LIMIT 10
    `).all() as any[];

    // Get volume on web per token (from offers)
    const tokenWebVol = db.prepare(`
      SELECT t.symbol, ROUND(SUM(o.value), 0) AS vol
      FROM offer o
      JOIN token t ON o.token_id = t.id
      WHERE o.created_at >= datetime('now', '-7 days') AND o.deleted_at IS NULL
      GROUP BY t.symbol
    `).all() as any[];
    const webVolMap = new Map(tokenWebVol.map((r: any) => [r.symbol, r.vol]));

    // Daily breakdown (2-sided)
    const daily = db.prepare(`
      SELECT DATE(created_at) AS day,
        ROUND(SUM(order_value_usd) * 2, 0) AS volume,
        COUNT(*) AS orders
      FROM _order_flat
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY day ORDER BY day
    `).all() as any[];

    // Fees
    const filledVol = current.filled_volume || 0;
    const feesTotal = filledVol * 0.025;

    return {
      startDate: start,
      endDate: end,
      totalVolumeOnWeb: Number(webVol.vol) || 0,
      filledVolume: current.filled_volume || 0,
      fillRate: (webVol.vol > 0 ? (current.filled_volume || 0) / webVol.vol * 100 : 0),
      totalOrders: current.total_orders || 0,
      totalUsers: newRow.count + oldRow.count,
      newUsers: newRow.count,
      oldUsers: oldRow.count,
      prevFilledVolume: prev.filled_volume || 0,
      prevTotalOrders: prev.total_orders || 0,
      prevTotalUsers: prevNewRow.count + prevOldRow.count,
      prevNewUsers: prevNewRow.count,
      prevOldUsers: prevOldRow.count,
      prevVolumeOnWeb: Number(prevWebVol.vol) || 0,
      topTokens: topTokens.map((t: any) => ({
        symbol: t.symbol,
        filledVolume: t.filled_volume,
        orders: t.orders,
        newWallets: t.new_wallets || 0,
        oldWallets: (t.total_wallets || 0) - (t.new_wallets || 0),
        volumeOnWeb: webVolMap.get(t.symbol) || 0,
      })),
      dailyVolume: daily.map((d: any) => ({ day: d.day, volume: d.volume, orders: d.orders })),
      feesTotal,
    };
  } finally {
    db.close();
  }
}

function wow(curr: number, prev: number): string {
  if (prev === 0) return curr > 0 ? "↑ new" : "—";
  const pct = ((curr - prev) / prev * 100);
  if (pct > 5) return `↑${pct.toFixed(1)}%`;
  if (pct < -5) return `↓${pct.toFixed(1)}%`;
  return `→${pct.toFixed(1)}%`;
}

function miniBar(value: number, max: number, len = 8): string {
  const filled = Math.round((value / Math.max(max, 1)) * len);
  return "█".repeat(Math.min(filled, len)) + "░".repeat(len - Math.min(filled, len));
}

export function formatWeeklySummary(a: WeeklyAnalysis): string {
  const L: string[] = [];

  L.push(`━━━━━━━━━━━━━━━━━━━━`);
  L.push(`  <b>WEEKLY REPORT</b>`);
  L.push(`  ${a.startDate}  →  ${a.endDate}`);
  L.push(`━━━━━━━━━━━━━━━━━━━━`);
  L.push(``);

  // KPIs
  L.push(`  <b>${moneySmart(a.filledVolume)}</b> filled volume`);
  L.push(`  <b>${a.totalOrders}</b> orders  ·  <b>${a.totalUsers}</b> users  ·  <b>${moneySmart(a.feesTotal)}</b> fees`);
  L.push(``);

  // Comparison table
  L.push(`┌──────────┬──────────┬──────────┐`);
  L.push(`│          │ <b>This wk</b>  │ <b>WoW</b>      │`);
  L.push(`├──────────┼──────────┼──────────┤`);
  L.push(`│ Web Vol  │ ${moneySmart(a.totalVolumeOnWeb).padEnd(8)} │ ${wow(a.totalVolumeOnWeb, a.prevVolumeOnWeb).padEnd(8)} │`);
  L.push(`│ Filled   │ ${moneySmart(a.filledVolume).padEnd(8)} │ ${wow(a.filledVolume, a.prevFilledVolume).padEnd(8)} │`);
  L.push(`│ Orders   │ ${String(a.totalOrders).padEnd(8)} │ ${wow(a.totalOrders, a.prevTotalOrders).padEnd(8)} │`);
  L.push(`│ Users    │ ${String(a.totalUsers).padEnd(8)} │ ${wow(a.totalUsers, a.prevTotalUsers).padEnd(8)} │`);
  L.push(`│  ├ New   │ ${String(a.newUsers).padEnd(8)} │ ${wow(a.newUsers, a.prevNewUsers).padEnd(8)} │`);
  L.push(`│  └ Old   │ ${String(a.oldUsers).padEnd(8)} │ ${wow(a.oldUsers, a.prevOldUsers).padEnd(8)} │`);
  L.push(`│ Fill %   │ ${(a.fillRate.toFixed(1) + "%").padEnd(8)} │          │`);
  L.push(`└──────────┴──────────┴──────────┘`);
  L.push(``);

  // Daily activity
  if (a.dailyVolume.length > 0) {
    L.push(`<b>DAILY ACTIVITY</b>`);
    const maxVol = Math.max(...a.dailyVolume.map(d => d.volume), 1);
    a.dailyVolume.forEach(d => {
      const dayName = new Date(d.day).toLocaleDateString("en", { weekday: "short" });
      const label = `${dayName} ${d.day.slice(5)}`;
      L.push(`${label.padEnd(10)} ${miniBar(d.volume, maxVol)}  <b>${moneySmart(d.volume)}</b>`);
    });
    L.push(``);
  }

  // Top tokens
  if (a.topTokens.length > 0) {
    L.push(`<b>TOP TOKENS</b>`);
    const maxTokVol = Math.max(...a.topTokens.map(t => t.filledVolume), 1);
    a.topTokens.slice(0, 5).forEach((t, i) => {
      const tw = t.newWallets + t.oldWallets;
      L.push(`${i + 1}. <b>$${t.symbol}</b>`);
      L.push(`   ${miniBar(t.filledVolume, maxTokVol)}  ${moneySmart(t.filledVolume)}  ·  ${t.orders} ord  ·  ${tw}w`);
    });
  }

  return L.join("\n");
}
