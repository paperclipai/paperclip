/**
 * Unified report builder for /daily, /weekly, /monthly
 * Same template, different time ranges
 */
import Database from "better-sqlite3";
import { moneySmart, growthBadge } from "./formatters.js";

export type Period = "daily" | "weekly" | "monthly";

export interface ReportData {
  period: Period;
  label: string;
  dateRange: string;

  // Platform
  filledVolume: number;
  prevFilledVolume: number;
  volumeOnWeb: number;
  prevVolumeOnWeb: number;
  totalOrders: number;
  prevTotalOrders: number;
  totalUsers: number;
  prevTotalUsers: number;
  newUsers: number;
  prevNewUsers: number;
  oldUsers: number;
  prevOldUsers: number;
  feesTotal: number;
  resaleVolume: number;
  topTokens: Array<{ symbol: string; volume: number; orders: number; wallets: number; newWallets: number }>;
  dailyBreakdown: Array<{ day: string; volume: number; orders: number }>;

  // GA4 (optional)
  ga4?: {
    activeUsers: number; activeUsersPct: number;
    newUsers: number; newUsersPct: number;
    sessions: number; sessionsPct: number;
    topPages: Array<{ token: string; sessions: number }>;
  };

  // Social (optional — raw HTML for Telegram)
  socialHtml?: string;

  // Social structured data (for HTML visual report)
  socialData?: {
    totalPosts: number;
    totalViews: number;
    totalLikes: number;
    totalRT: number;
    totalReplies: number;
    totalBookmarks: number;
    engRate: number;
    topPosts: Array<{ date: string; content: string; views: number; likes: number; retweets: number; bookmarks: number; link: string }>;
  };
}

function getRange(period: Period): { sql: string; sqlPrev: string; sqlEnd: string; days: number } {
  switch (period) {
    case "daily": return { sql: "datetime('now', '-1 day')", sqlPrev: "datetime('now', '-2 days')", sqlEnd: "datetime('now', '-1 day')", days: 1 };
    case "weekly": return { sql: "datetime('now', '-7 days')", sqlPrev: "datetime('now', '-14 days')", sqlEnd: "datetime('now', '-7 days')", days: 7 };
    case "monthly": return { sql: "datetime('now', '-30 days')", sqlPrev: "datetime('now', '-60 days')", sqlEnd: "datetime('now', '-30 days')", days: 30 };
  }
}

export function buildReportData(dbPath: string, period: Period): ReportData {
  const db = new Database(dbPath, { readonly: true });
  const r = getRange(period);

  try {
    const labels: Record<Period, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" };

    // Date range label
    const startRow = db.prepare(`SELECT DATE(${r.sql}) AS d`).get() as any;
    const endRow = db.prepare(`SELECT DATE('now') AS d`).get() as any;
    const dateRange = period === "daily"
      ? endRow.d
      : `${startRow.d}  →  ${endRow.d}`;

    // Current period: volume, orders (2-sided)
    const curr = db.prepare(`
      SELECT ROUND(SUM(order_value_usd) * 2, 2) AS vol, COUNT(*) AS ord
      FROM _order_flat WHERE created_at >= ${r.sql}
    `).get() as any;

    // Previous period
    const prev = db.prepare(`
      SELECT ROUND(SUM(order_value_usd) * 2, 2) AS vol, COUNT(*) AS ord
      FROM _order_flat WHERE created_at >= ${r.sqlPrev} AND created_at < ${r.sql}
    `).get() as any;

    // Volume on web (offers)
    const webVol = db.prepare(`
      SELECT ROUND(SUM(value), 2) AS vol FROM offer
      WHERE created_at >= ${r.sql} AND deleted_at IS NULL
    `).get() as any;
    const prevWebVol = db.prepare(`
      SELECT ROUND(SUM(value), 2) AS vol FROM offer
      WHERE created_at >= ${r.sqlPrev} AND created_at < ${r.sql} AND deleted_at IS NULL
    `).get() as any;

    // Users: current
    const users = db.prepare(`
      WITH wu AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= ${r.sql}
        UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= ${r.sql}
      ),
      cl AS (
        SELECT uid, CASE WHEN EXISTS (
          SELECT 1 FROM _order_flat o2 WHERE (o2.buyer_id = wu.uid OR o2.seller_id = wu.uid) AND o2.created_at < ${r.sql}
        ) THEN 'Old' ELSE 'New' END AS t FROM wu
      )
      SELECT t, COUNT(*) AS c FROM cl GROUP BY t
    `).all() as any[];
    const newU = users.find((u: any) => u.t === "New")?.c || 0;
    const oldU = users.find((u: any) => u.t === "Old")?.c || 0;

    // Users: previous
    const prevUsers = db.prepare(`
      WITH wu AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= ${r.sqlPrev} AND created_at < ${r.sql}
        UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= ${r.sqlPrev} AND created_at < ${r.sql}
      ),
      cl AS (
        SELECT uid, CASE WHEN EXISTS (
          SELECT 1 FROM _order_flat o2 WHERE (o2.buyer_id = wu.uid OR o2.seller_id = wu.uid) AND o2.created_at < ${r.sqlPrev}
        ) THEN 'Old' ELSE 'New' END AS t FROM wu
      )
      SELECT t, COUNT(*) AS c FROM cl GROUP BY t
    `).all() as any[];
    const prevNewU = prevUsers.find((u: any) => u.t === "New")?.c || 0;
    const prevOldU = prevUsers.find((u: any) => u.t === "Old")?.c || 0;

    // Top tokens (2-sided)
    const topTokens = db.prepare(`
      SELECT token_symbol AS sym, ROUND(SUM(order_value_usd) * 2, 0) AS vol,
        COUNT(*) AS ord,
        COUNT(DISTINCT buyer_id) + COUNT(DISTINCT seller_id) AS wallets
      FROM _order_flat WHERE created_at >= ${r.sql}
      GROUP BY token_symbol ORDER BY vol DESC LIMIT 8
    `).all() as any[];

    // Daily breakdown (2-sided)
    const daily = db.prepare(`
      SELECT DATE(created_at) AS day, ROUND(SUM(order_value_usd) * 2, 0) AS vol, COUNT(*) AS ord
      FROM _order_flat WHERE created_at >= ${r.sql}
      GROUP BY day ORDER BY day
    `).all() as any[];

    // Resale
    const resale = db.prepare(`
      SELECT SUM(CASE WHEN is_exit_position THEN order_value_usd ELSE 0 END) * 2 AS vol
      FROM _order_flat WHERE created_at >= ${r.sql}
    `).get() as any;

    const filledVol = curr.vol || 0;

    return {
      period,
      label: labels[period],
      dateRange,
      filledVolume: filledVol,
      prevFilledVolume: prev.vol || 0,
      volumeOnWeb: Number(webVol.vol) || 0,
      prevVolumeOnWeb: Number(prevWebVol.vol) || 0,
      totalOrders: curr.ord || 0,
      prevTotalOrders: prev.ord || 0,
      totalUsers: newU + oldU,
      prevTotalUsers: prevNewU + prevOldU,
      newUsers: newU,
      prevNewUsers: prevNewU,
      oldUsers: oldU,
      prevOldUsers: prevOldU,
      feesTotal: filledVol * 0.025,
      resaleVolume: resale.vol || 0,
      topTokens: topTokens.map((t: any) => ({ symbol: t.sym, volume: t.vol, orders: t.ord, wallets: t.wallets, newWallets: 0 })),
      dailyBreakdown: daily.map((d: any) => ({ day: d.day, volume: d.vol, orders: d.ord })),
    };
  } finally {
    db.close();
  }
}

// ── Format ──

function chg(curr: number, prev: number): string {
  if (prev === 0) return curr > 0 ? "⬆" : "";
  const pct = ((curr - prev) / prev * 100);
  if (pct > 0) return `⬆${pct.toFixed(1)}%`;
  if (pct < 0) return `⬇${Math.abs(pct).toFixed(1)}%`;
  return "";
}

export function formatReport(d: ReportData): string {
  const fillRate = d.volumeOnWeb > 0 ? (d.filledVolume / d.volumeOnWeb * 100) : 0;
  const acqRate = d.totalUsers > 0 ? (d.newUsers / d.totalUsers * 100) : 0;

  const L: string[] = [];

  // Header
  L.push(`<b>📊 ${d.label} REPORT</b>`);
  L.push(`${d.dateRange}`);
  L.push(``);
  L.push(`<b>${moneySmart(d.filledVolume)}</b> vol · <b>${d.totalOrders}</b> orders · <b>${d.totalUsers}</b> users`);

  // Platform
  L.push(``);
  L.push(`<b>📈 PLATFORM</b>`);
  L.push(`Filled Vol · <b>${moneySmart(d.filledVolume)}</b> ${chg(d.filledVolume, d.prevFilledVolume)}`);
  L.push(`Web Vol · <b>${moneySmart(d.volumeOnWeb)}</b> ${chg(d.volumeOnWeb, d.prevVolumeOnWeb)}`);
  L.push(`Fill Rate · <b>${fillRate.toFixed(1)}%</b>`);
  L.push(`Orders · <b>${d.totalOrders}</b> ${chg(d.totalOrders, d.prevTotalOrders)}`);
  L.push(`Users · <b>${d.totalUsers}</b> ${chg(d.totalUsers, d.prevTotalUsers)}`);
  L.push(`  New <b>${d.newUsers}</b> ${chg(d.newUsers, d.prevNewUsers)} · Old <b>${d.oldUsers}</b> ${chg(d.oldUsers, d.prevOldUsers)}`);
  L.push(`Acq Rate · <b>${acqRate.toFixed(0)}%</b> · Fees · <b>${moneySmart(d.feesTotal)}</b>`);
  if (d.resaleVolume > 0) L.push(`Resale · ${moneySmart(d.resaleVolume)}`);

  // Activity
  if (d.dailyBreakdown.length > 1) {
    L.push(``);
    L.push(`<b>📅 ACTIVITY</b>`);

    let items: Array<{ label: string; vol: number; ord: number }> = [];
    if (d.period === "monthly") {
      const weeks = new Map<string, { vol: number; ord: number }>();
      d.dailyBreakdown.forEach(x => {
        const dt = new Date(x.day + "T12:00:00");
        const ws = new Date(dt);
        ws.setDate(dt.getDate() - dt.getDay() + 1);
        const key = ws.toISOString().slice(5, 10);
        const w = weeks.get(key) || { vol: 0, ord: 0 };
        w.vol += x.volume; w.ord += x.orders;
        weeks.set(key, w);
      });
      items = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, w]) => ({ label: `W${k}`, vol: w.vol, ord: w.ord }));
    } else {
      items = d.dailyBreakdown.map(x => ({
        label: new Date(x.day + "T12:00:00").toLocaleDateString("en", { weekday: "short" }),
        vol: x.volume, ord: x.orders,
      }));
    }

    items.forEach(x => {
      L.push(`${x.label} · <b>${moneySmart(x.vol)}</b> · ${x.ord} ord`);
    });
  }

  // Tokens
  if (d.topTokens.length > 0) {
    L.push(``);
    L.push(`<b>🏅 TOKENS</b>`);
    d.topTokens.slice(0, 5).forEach((t, i) => {
      L.push(`${i + 1}. <b>$${t.symbol}</b> · ${moneySmart(t.volume)} · ${t.orders} ord · ${t.wallets}w`);
    });
  }

  // Social
  L.push(``);
  L.push(`<b>📱 SOCIAL</b>`);
  if (d.socialHtml) {
    L.push(d.socialHtml);
  } else {
    L.push(`No posts ${d.period === "daily" ? "yesterday" : `in the last ${d.period === "weekly" ? "7" : "30"} days`}`);
  }

  // GA4
  if (d.ga4) {
    L.push(``);
    L.push(`<b>🌐 WEBSITE</b>`);
    L.push(`Active · <b>${moneySmart(d.ga4.activeUsers, "")}</b> ${chg(d.ga4.activeUsers, d.ga4.activeUsers / (1 + d.ga4.activeUsersPct / 100))}`);
    L.push(`New Users · <b>${moneySmart(d.ga4.newUsers, "")}</b> ${chg(d.ga4.newUsers, d.ga4.newUsers / (1 + d.ga4.newUsersPct / 100))}`);
    L.push(`Sessions · <b>${moneySmart(d.ga4.sessions, "")}</b> ${chg(d.ga4.sessions, d.ga4.sessions / (1 + d.ga4.sessionsPct / 100))}`);
    if (d.ga4.topPages.length > 0) {
      d.ga4.topPages.forEach(p => {
        L.push(`  $${p.token} · ${p.sessions} sessions`);
      });
    }
  }

  return L.join("\n");
}
