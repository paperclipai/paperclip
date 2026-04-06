import Database from "better-sqlite3";
import { moneySmart } from "./formatters.js";

export interface TokenAnalysis {
  symbol: string;
  // 1. Settle Performance
  totalOrders: number;
  settledOrders: number;
  cancelledOrders: number;
  settleRate: number;
  totalValueUsd: number;
  // 2. Volume
  askVolume: number;
  bidVolume: number;
  bidSharePct: number;
  // 3. Order Value Distribution
  orderBuckets: Array<{ bucket: string; orders: number; totalUsd: number }>;
  // 4. Weekly Trend
  weeklyTrend: Array<{ week: string; volume: number; orders: number }>;
  // 5. Peak Days
  peakDays: Array<{ day: string; volume: number; pctOfTotal: number }>;
  // 6. Users
  newUsers: number;
  oldUsers: number;
  newUserPct: number;
  // 7. Whale Concentration
  top5WhalePct: number;
  // 8. Wallet Distribution
  walletTiers: Array<{ tier: string; wallets: number; volume: number }>;
  // 9. Resale
  resaleVolume: number;
  resalePct: number;
  // 10. Fees
  feesSpot: number;
  feesResale: number;
  feesTotal: number;
  // 11. Top Wallets
  topWallets: Array<{ address: string; volume: number; orders: number; role: string }>;
}

export function analyzeToken(dbPath: string, symbol: string): TokenAnalysis | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check token exists
    const tokenCheck = db.prepare(
      `SELECT COUNT(*) AS c FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE`
    ).get(symbol) as { c: number };
    if (!tokenCheck || tokenCheck.c === 0) return null;

    // 1. Settle Performance (2-sided volume to match Metabase)
    const settle = db.prepare(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'close' AND NOT is_exit_position THEN 1 ELSE 0 END) AS settled,
        SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END) AS cancelled,
        ROUND(SUM(CASE WHEN status = 'close' AND NOT is_exit_position THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) AS settle_rate,
        ROUND(SUM(order_value_usd) * 2, 2) AS total_value_usd,
        ROUND(SUM(CASE WHEN status = 'close' AND NOT is_exit_position THEN order_value_usd ELSE 0 END) * 2, 2) AS settled_value_usd
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
    `).get(symbol) as any;

    // 2. Ask vs Bid
    const askBid = db.prepare(`
      SELECT
        COALESCE(total_volume_ask, 0) AS ask_vol,
        COALESCE(total_volume_bid, 0) AS bid_vol,
        ROUND(COALESCE(total_volume_bid, 0) * 100.0 /
          NULLIF(COALESCE(total_volume_ask, 0) + COALESCE(total_volume_bid, 0), 0), 1) AS bid_pct
      FROM token WHERE symbol = ? COLLATE NOCASE AND deleted_at IS NULL
    `).get(symbol) as any || { ask_vol: 0, bid_vol: 0, bid_pct: 0 };

    // 3. Order Value Distribution (use 2-sided per order)
    const buckets = db.prepare(`
      SELECT
        CASE
          WHEN order_value_usd * 2 < 500 THEN 'Under $500'
          WHEN order_value_usd * 2 < 1000 THEN '$500-1K'
          WHEN order_value_usd * 2 < 3000 THEN '$1K-3K'
          WHEN order_value_usd * 2 < 7000 THEN '$3K-7K'
          WHEN order_value_usd * 2 < 10000 THEN '$7K-10K'
          WHEN order_value_usd * 2 < 20000 THEN '$10K-20K'
          ELSE '$20K+'
        END AS bucket,
        COUNT(*) AS orders,
        ROUND(SUM(order_value_usd) * 2, 0) AS total_usd
      FROM _order_flat
      WHERE token_symbol = ? COLLATE NOCASE
      GROUP BY bucket ORDER BY MIN(order_value_usd)
    `).all(symbol) as any[];

    // 4. Weekly Trend (2-sided)
    const weekly = db.prepare(`
      SELECT strftime('%Y-W%W', created_at) AS week,
        ROUND(SUM(order_value_usd) * 2, 0) AS volume,
        COUNT(*) AS orders
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
      GROUP BY week ORDER BY week
    `).all(symbol) as any[];

    // 5. Peak Days (2-sided)
    const peaks = db.prepare(`
      WITH daily AS (
        SELECT DATE(created_at) AS day, SUM(order_value_usd) * 2 AS vol
        FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY day
      ), total AS (SELECT SUM(vol) AS tv FROM daily)
      SELECT day, ROUND(vol, 0) AS volume,
        ROUND(vol * 100.0 / t.tv, 1) AS pct_of_total
      FROM daily, total t ORDER BY vol DESC LIMIT 5
    `).all(symbol) as any[];

    // 6. New vs Old Users
    const users = db.prepare(`
      WITH token_users AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
        UNION
        SELECT DISTINCT seller_id FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
      ),
      classified AS (
        SELECT tu.uid,
          CASE WHEN EXISTS (
            SELECT 1 FROM _order_flat o2
            WHERE (o2.buyer_id = tu.uid OR o2.seller_id = tu.uid)
              AND LOWER(o2.token_symbol) != LOWER(?)
          ) THEN 'Old' ELSE 'New' END AS user_type
        FROM token_users tu
      )
      SELECT user_type, COUNT(*) AS count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM classified), 1) AS pct
      FROM classified GROUP BY user_type
    `).all(symbol, symbol, symbol) as any[];

    const newRow = users.find((u: any) => u.user_type === "New") || { count: 0, pct: 0 };
    const oldRow = users.find((u: any) => u.user_type === "Old") || { count: 0, pct: 0 };

    // 7. Whale Concentration (ratio stays same, ×2 cancels out)
    const whale = db.prepare(`
      WITH wallet_vol AS (
        SELECT buyer_id AS uid, SUM(order_value_usd) AS vol FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY buyer_id
        UNION ALL
        SELECT seller_id, SUM(order_value_usd) FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY seller_id
      ),
      agg AS (SELECT uid, SUM(vol) AS total_vol FROM wallet_vol GROUP BY uid ORDER BY total_vol DESC LIMIT 5)
      SELECT ROUND(SUM(a.total_vol) * 100.0 / (SELECT SUM(order_value_usd) FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE), 1) AS top5_pct
      FROM agg a
    `).get(symbol, symbol, symbol) as any || { top5_pct: 0 };

    // 8. Wallet Distribution (2-sided)
    const walletTiers = db.prepare(`
      WITH wallet_vol AS (
        SELECT buyer_id AS uid, SUM(order_value_usd) * 2 AS vol FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY buyer_id
        UNION ALL
        SELECT seller_id, SUM(order_value_usd) * 2 FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY seller_id
      ),
      agg AS (SELECT uid, SUM(vol) AS total_vol FROM wallet_vol GROUP BY uid)
      SELECT
        CASE
          WHEN total_vol < 1000 THEN 'Under $1K'
          WHEN total_vol < 5000 THEN '$1K-5K'
          WHEN total_vol < 20000 THEN '$5K-20K'
          WHEN total_vol < 100000 THEN '$20K-100K'
          ELSE '$100K+'
        END AS tier,
        COUNT(*) AS wallets,
        ROUND(SUM(total_vol), 0) AS volume
      FROM agg GROUP BY tier ORDER BY MIN(total_vol)
    `).all(symbol, symbol) as any[];

    // 9. Resale (2-sided, is_exit_position stored as text '1.0')
    const resale = db.prepare(`
      SELECT
        SUM(CASE WHEN is_exit_position THEN order_value_usd ELSE 0 END) * 2 AS resale_vol,
        SUM(order_value_usd) * 2 AS total_vol,
        ROUND(SUM(CASE WHEN is_exit_position THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) AS resale_pct
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
    `).get(symbol) as any;

    // 10. Fees
    const settledVol = settle.total_value_usd || 0;
    const resaleVol = resale.resale_vol || 0;
    const spotVol = Math.max(settledVol - resaleVol, 0);
    const feesSpot = spotVol * 0.025;
    const feesResale = resaleVol * 0.05;

    // 11. Top Wallets (2-sided)
    const topWallets = db.prepare(`
      WITH wallet_vol AS (
        SELECT buyer_id AS uid, SUM(order_value_usd) * 2 AS vol, COUNT(*) AS cnt, 'Buyer' AS role
        FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY buyer_id
        UNION ALL
        SELECT seller_id, SUM(order_value_usd) * 2, COUNT(*), 'Seller'
        FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY seller_id
      )
      SELECT u.address, wv.vol AS volume, wv.cnt AS orders, wv.role
      FROM wallet_vol wv
      JOIN users u ON wv.uid = u.id
      ORDER BY wv.vol DESC LIMIT 10
    `).all(symbol, symbol) as any[];

    return {
      symbol: symbol.toUpperCase(),
      totalOrders: settle.total_orders,
      settledOrders: settle.settled,
      cancelledOrders: settle.cancelled,
      settleRate: settle.settle_rate || 0,
      totalValueUsd: settle.total_value_usd || 0,
      askVolume: Number(askBid.ask_vol) || 0,
      bidVolume: Number(askBid.bid_vol) || 0,
      bidSharePct: Number(askBid.bid_pct) || 0,
      orderBuckets: buckets.map((b: any) => ({ bucket: b.bucket, orders: b.orders, totalUsd: b.total_usd })),
      weeklyTrend: weekly.map((w: any) => ({ week: w.week, volume: w.volume, orders: w.orders })),
      peakDays: peaks.map((p: any) => ({ day: p.day, volume: p.volume, pctOfTotal: p.pct_of_total })),
      newUsers: newRow.count,
      oldUsers: oldRow.count,
      newUserPct: newRow.pct,
      top5WhalePct: whale.top5_pct || 0,
      walletTiers: walletTiers.map((t: any) => ({ tier: t.tier, wallets: t.wallets, volume: t.volume })),
      resaleVolume: resale.resale_vol || 0,
      resalePct: resale.resale_pct || 0,
      feesSpot,
      feesResale,
      feesTotal: feesSpot + feesResale,
      topWallets: topWallets.map((w: any) => ({
        address: w.address ? `${w.address.slice(0, 6)}...${w.address.slice(-4)}` : "?",
        volume: w.volume, orders: w.orders, role: w.role,
      })),
    };
  } finally {
    db.close();
  }
}

export function formatTokenSummary(a: TokenAnalysis): string {
  const totalUsers = a.newUsers + a.oldUsers;
  const askBidTotal = a.askVolume + a.bidVolume;
  const fillRate = askBidTotal > 0 ? (a.totalValueUsd / askBidTotal * 100) : 0;
  const askPct = askBidTotal > 0 ? Math.round(a.askVolume / askBidTotal * 100) : 50;
  const bidPct = 100 - askPct;

  let momentum = "–";
  if (a.weeklyTrend.length >= 2) {
    const last = a.weeklyTrend[a.weeklyTrend.length - 1].volume;
    const prev = a.weeklyTrend[a.weeklyTrend.length - 2].volume;
    const change = prev > 0 ? ((last - prev) / prev * 100) : 0;
    if (change > 10) momentum = "⬆ Trending Up";
    else if (change < -10) momentum = "⬇ Cooling Down";
    else momentum = "→ Stable";
  }

  const peakConc = a.peakDays.length > 0 ? a.peakDays[0].pctOfTotal : 0;
  const sig = (v: number, good: number, warn: number) => v >= good ? "🟢" : v >= warn ? "🟡" : "🔴";

  const L: string[] = [];

  // Header
  L.push(`<b>🔍 $${a.symbol} TOKEN REPORT</b>`);
  L.push(``);
  L.push(`<b>${moneySmart(a.totalValueUsd)}</b> vol · <b>${a.totalOrders.toLocaleString()}</b> orders · <b>${totalUsers}</b> users · <b>${moneySmart(a.feesTotal)}</b> fees`);

  // Health
  L.push(``);
  L.push(`<b>⚡ HEALTH</b>`);
  L.push(`${sig(fillRate, 50, 20)} Fill Rate · <b>${fillRate.toFixed(1)}%</b>`);
  if (a.settleRate > 0) {
    L.push(`${sig(a.settleRate, 80, 50)} Settle · <b>${a.settleRate}%</b> (${a.settledOrders}/${a.totalOrders})`);
  } else {
    L.push(`⚪ Settle · <b>pre-TGE</b>`);
  }
  L.push(`${sig(100 - a.top5WhalePct, 60, 40)} Whale Risk · Top 5 = <b>${a.top5WhalePct}%</b>`);
  L.push(`${sig(a.newUserPct, 70, 30)} Acquisition · <b>${a.newUserPct}%</b> new (${a.newUsers} new · ${a.oldUsers} old)`);

  // Momentum
  L.push(``);
  L.push(`<b>📊 MOMENTUM</b> ${momentum}`);
  L.push(`Peak · ${a.peakDays[0]?.day || "—"} (${peakConc}% of total)`);
  if (a.cancelledOrders > 0) {
    L.push(`Cancelled · ${a.cancelledOrders} (${(a.cancelledOrders / a.totalOrders * 100).toFixed(1)}%)`);
  }

  // Orderbook
  L.push(``);
  L.push(`<b>📖 ORDERBOOK</b>`);
  L.push(`Ask <b>${askPct}%</b> · Bid <b>${bidPct}%</b>`);
  L.push(bidPct > 60 ? "→ Buy demand dominant" : bidPct < 30 ? "→ Sell pressure dominant" : "→ Balanced");

  return L.join("\n");
}
