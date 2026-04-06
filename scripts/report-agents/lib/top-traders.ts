import Database from "better-sqlite3";
import { moneySmart } from "./formatters.js";

export interface TraderProfile {
  address: string;
  shortAddr: string;
  totalVolume: number;
  totalOrders: number;
  avgOrderSize: number;
  tokenDiversity: number;
  tradedTokens: string;
  buyerRatio: number;
  resalePct: number;
  firstOrderDate: string;
  lastOrderDate: string;
  activeDays: number;
  recentDays: number;
  longestStreak: number;
  whaleType: string;
}

export function getTopTraders(dbPath: string, options?: { token?: string; limit?: number }): TraderProfile[] {
  const db = new Database(dbPath, { readonly: true });
  const token = options?.token?.toUpperCase();
  const limit = options?.limit || 10;

  try {
    const tokenFilter = token ? `AND o.token_symbol = '${token}' COLLATE NOCASE` : "";

    const rows = db.prepare(`
      WITH base AS (
        SELECT
          CASE WHEN o.buyer_id = u.id THEN 'Buyer' ELSE 'Seller' END AS role,
          u.id AS uid,
          u.address,
          DATE(o.created_at) AS trade_day,
          o.created_at,
          o.status,
          o.token_symbol,
          o.order_value_usd * 2 AS order_value_usd,
          o.is_exit_position
        FROM _order_flat o
        JOIN users u ON (o.buyer_id = u.id OR o.seller_id = u.id)
        WHERE o.status = 'close' ${tokenFilter}
      ),

      distinct_days AS (
        SELECT DISTINCT address, trade_day FROM base
      ),

      streaks AS (
        SELECT address, trade_day,
          julianday(trade_day) - ROW_NUMBER() OVER (PARTITION BY address ORDER BY trade_day) AS grp
        FROM distinct_days
      ),

      streak_count AS (
        SELECT address, COUNT(*) AS streak_len FROM streaks GROUP BY address, grp
      ),

      longest_streak AS (
        SELECT address, MAX(streak_len) AS longest FROM streak_count GROUP BY address
      ),

      agg AS (
        SELECT
          b.address,
          COUNT(*) AS total_orders,
          ROUND(SUM(b.order_value_usd), 2) AS total_volume,
          ROUND(AVG(b.order_value_usd), 0) AS avg_order_size,
          COUNT(DISTINCT b.token_symbol) AS token_diversity,
          GROUP_CONCAT(DISTINCT b.token_symbol) AS traded_tokens,
          ROUND(SUM(CASE WHEN b.role = 'Buyer' THEN 1.0 ELSE 0 END) / COUNT(*), 2) AS buyer_ratio,
          ROUND(SUM(CASE WHEN b.is_exit_position THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) AS resale_pct,
          MIN(DATE(b.created_at)) AS first_order,
          MAX(DATE(b.created_at)) AS last_order,
          CAST(julianday('now') - julianday(MAX(b.created_at)) AS INTEGER) AS recent_days,
          CAST(julianday('now') - julianday(MIN(b.created_at)) AS INTEGER) AS active_days,
          COALESCE(ls.longest, 1) AS longest_streak
        FROM base b
        LEFT JOIN longest_streak ls ON b.address = ls.address
        GROUP BY b.address, ls.longest
      )

      SELECT *,
        CASE
          WHEN total_orders > 50 AND buyer_ratio BETWEEN 0.35 AND 0.65 THEN 'Market Maker'
          WHEN buyer_ratio > 0.7 AND avg_order_size > 5000 THEN 'Accumulator'
          WHEN buyer_ratio < 0.3 THEN 'Dumper'
          WHEN resale_pct > 30 THEN 'Flipper'
          ELSE 'Trader'
        END AS whale_type
      FROM agg ORDER BY total_volume DESC LIMIT ?
    `).all(limit) as any[];

    return rows.map((r: any) => ({
      address: r.address || "?",
      shortAddr: r.address ? `${r.address.slice(0, 6)}...${r.address.slice(-4)}` : "?",
      totalVolume: r.total_volume || 0,
      totalOrders: r.total_orders || 0,
      avgOrderSize: r.avg_order_size || 0,
      tokenDiversity: r.token_diversity || 0,
      tradedTokens: r.traded_tokens || "",
      buyerRatio: r.buyer_ratio || 0,
      resalePct: r.resale_pct || 0,
      firstOrderDate: r.first_order || "",
      lastOrderDate: r.last_order || "",
      activeDays: r.active_days || 0,
      recentDays: r.recent_days || 0,
      longestStreak: r.longest_streak || 0,
      whaleType: r.whale_type || "Trader",
    }));
  } finally {
    db.close();
  }
}

export function formatTopTraders(traders: TraderProfile[], token?: string): string {
  if (traders.length === 0) return token ? `No traders found for $${token}` : "No traders found";

  // Group by type for summary
  const typeCounts: Record<string, { count: number; vol: number }> = {};
  traders.forEach(t => {
    const tc = typeCounts[t.whaleType] || { count: 0, vol: 0 };
    tc.count++; tc.vol += t.totalVolume;
    typeCounts[t.whaleType] = tc;
  });

  const typeIcon: Record<string, string> = {
    "Market Maker": "🔵", "Accumulator": "🟢", "Dumper": "🔴", "Flipper": "🟡", "Trader": "⚪",
  };

  const L: string[] = [];
  L.push(`<b>🏆 TOP TRADERS</b>${token ? ` · $${token}` : ""}`);
  L.push(``);

  // Type summary
  const sorted = Object.entries(typeCounts).sort((a, b) => b[1].vol - a[1].vol);
  L.push(sorted.map(([type, { count, vol }]) => `${typeIcon[type] || "⚪"}${type} ${count} (${moneySmart(vol)})`).join(" · "));
  L.push(``);

  // Individual traders
  traders.forEach((t, i) => {
    const icon = typeIcon[t.whaleType] || "⚪";
    const buyPct = (t.buyerRatio * 100).toFixed(0);

    L.push(`<b>${i + 1}. ${t.shortAddr}</b>  ${icon} ${t.whaleType}`);
    L.push(`   ${moneySmart(t.totalVolume)} vol · ${t.totalOrders} ord · avg ${moneySmart(t.avgOrderSize)}`);
    L.push(`   Buy ${buyPct}%${t.resalePct > 0 ? ` · Resale ${t.resalePct}%` : ""} · ${t.firstOrderDate} → ${t.lastOrderDate}`);
    if (i < traders.length - 1) L.push(``);
  });

  return L.join("\n");
}
