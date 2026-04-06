/**
 * Trader Forensic Analysis — full behavioral classification
 * 8 modules: concentration, classification, speculation, user quality,
 * order size, temporal pattern, red flags, conclusion
 */
import Database from "better-sqlite3";
import { moneySmart } from "./formatters.js";

export interface ForensicReport {
  symbol: string;
  totalVolume: number;
  totalOrders: number;
  totalWallets: number;

  // 1. Concentration
  top10Pct: number;
  top20Pct: number;
  top50Pct: number;
  concentrationLevel: string; // "Low" | "High" | "Critical"

  // 2. Wallet classification
  classification: {
    dumpers: number; accumulators: number; marketMakers: number; flippers: number; traders: number;
    dumperVol: number; accumulatorVol: number; mmVol: number; flipperVol: number; traderVol: number;
  };
  dominantBehavior: string;

  // 3. Speculation
  resalePct: number;
  resaleLevel: string;
  highResaleWallets: number; // wallets with >50% resale

  // 4. User quality
  newUserPct: number;
  userQuality: string;

  // 5. Order size distribution
  whaleVolPct: number; // >$20K
  midVolPct: number; // $1K-$20K
  retailVolPct: number; // <$1K
  retailLevel: string;

  // 6. Temporal patterns
  peakDays: Array<{ day: string; vol: number; pct: number }>;
  avgDailyVol: number;
  maxDailyVol: number;
  spikeRatio: number; // max / avg
  isOrganic: boolean;

  // 7. Red flags
  redFlags: string[];

  // 8. Conclusion
  riskLevel: string; // "Low" | "Medium" | "High" | "Critical"
  riskScore: number; // 0-100

  // Top wallets detail
  topWallets: Array<{
    address: string; vol: number; orders: number; avgSize: number;
    buyPct: number; resalePct: number; type: string; period: string;
  }>;
}

export function runForensic(dbPath: string, symbol: string): ForensicReport | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check token exists
    const check = db.prepare(`SELECT COUNT(*) AS c FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE`).get(symbol) as any;
    if (!check || check.c === 0) return null;

    const sym = symbol.toUpperCase();

    // Total metrics
    const totals = db.prepare(`
      SELECT ROUND(SUM(order_value_usd)*2, 0) AS vol, COUNT(*) AS ord FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
    `).get(symbol) as any;

    const totalWallets = db.prepare(`
      WITH w AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
        UNION SELECT DISTINCT seller_id FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
      ) SELECT COUNT(*) AS c FROM w
    `).get(symbol, symbol) as any;

    // ── 1. CONCENTRATION ──
    const walletVols = db.prepare(`
      WITH w AS (
        SELECT buyer_id AS uid, SUM(order_value_usd)*2 AS vol FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY buyer_id
        UNION ALL
        SELECT seller_id, SUM(order_value_usd)*2 FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY seller_id
      )
      SELECT uid, SUM(vol) AS tv FROM w GROUP BY uid ORDER BY tv DESC
    `).all(symbol, symbol) as any[];

    const totalVol = totals.vol || 1;
    const sumTop = (n: number) => walletVols.slice(0, n).reduce((s: number, w: any) => s + w.tv, 0);
    const top10Pct = Math.round(sumTop(10) / totalVol * 100 * 10) / 10;
    const top20Pct = Math.round(sumTop(20) / totalVol * 100 * 10) / 10;
    const top50Pct = Math.round(sumTop(50) / totalVol * 100 * 10) / 10;

    // ── 2. CLASSIFICATION ──
    const classified = db.prepare(`
      WITH base AS (
        SELECT u.address, u.id AS uid,
          COUNT(*) AS ord, ROUND(SUM(o.order_value_usd)*2, 0) AS vol,
          ROUND(AVG(o.order_value_usd)*2, 0) AS avg_size,
          ROUND(SUM(CASE WHEN o.buyer_id = u.id THEN 1.0 ELSE 0 END) / COUNT(*), 2) AS buy_r,
          ROUND(SUM(CASE WHEN is_exit_position THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) AS resale,
          MIN(DATE(o.created_at)) AS first_d, MAX(DATE(o.created_at)) AS last_d
        FROM _order_flat o JOIN users u ON (o.buyer_id = u.id OR o.seller_id = u.id)
        WHERE o.token_symbol = ? COLLATE NOCASE
        GROUP BY u.address, u.id HAVING vol > 1000
      )
      SELECT *, CASE
        WHEN ord > 50 AND buy_r BETWEEN 0.35 AND 0.65 THEN 'Market Maker'
        WHEN buy_r > 0.7 AND avg_size > 5000 THEN 'Accumulator'
        WHEN buy_r < 0.3 THEN 'Dumper'
        WHEN resale > 30 THEN 'Flipper'
        ELSE 'Trader'
      END AS wtype FROM base ORDER BY vol DESC
    `).all(symbol) as any[];

    const countType = (t: string) => classified.filter((w: any) => w.wtype === t).length;
    const volType = (t: string) => classified.filter((w: any) => w.wtype === t).reduce((s: number, w: any) => s + w.vol, 0);
    const classification = {
      dumpers: countType("Dumper"), accumulators: countType("Accumulator"),
      marketMakers: countType("Market Maker"), flippers: countType("Flipper"), traders: countType("Trader"),
      dumperVol: volType("Dumper"), accumulatorVol: volType("Accumulator"),
      mmVol: volType("Market Maker"), flipperVol: volType("Flipper"), traderVol: volType("Trader"),
    };
    const maxVol = Math.max(classification.dumperVol, classification.accumulatorVol, classification.mmVol, classification.flipperVol);
    const dominantBehavior = maxVol === classification.dumperVol ? "Selling Pressure" :
      maxVol === classification.accumulatorVol ? "Accumulation" :
      maxVol === classification.mmVol ? "Market Making" : "Speculation";

    // ── 3. SPECULATION ──
    const resale = db.prepare(`
      SELECT ROUND(SUM(CASE WHEN is_exit_position THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) AS pct
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
    `).get(symbol) as any;
    const resalePct = resale.pct || 0;
    const highResaleWallets = classified.filter((w: any) => w.resale > 50).length;

    // ── 4. USER QUALITY ──
    const users = db.prepare(`
      WITH tu AS (
        SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
        UNION SELECT DISTINCT seller_id FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
      ),
      cl AS (
        SELECT uid, CASE WHEN EXISTS (
          SELECT 1 FROM _order_flat o2 WHERE (o2.buyer_id = tu.uid OR o2.seller_id = tu.uid) AND LOWER(o2.token_symbol) != LOWER(?)
        ) THEN 'Old' ELSE 'New' END AS t FROM tu
      )
      SELECT t, COUNT(*) AS c FROM cl GROUP BY t
    `).all(symbol, symbol, symbol) as any[];
    const newU = users.find((u: any) => u.t === "New")?.c || 0;
    const oldU = users.find((u: any) => u.t === "Old")?.c || 0;
    const newUserPct = (newU + oldU) > 0 ? Math.round(newU / (newU + oldU) * 1000) / 10 : 0;

    // ── 5. ORDER SIZE ──
    const sizes = db.prepare(`
      SELECT
        ROUND(SUM(CASE WHEN order_value_usd*2 >= 20000 THEN order_value_usd*2 ELSE 0 END) / SUM(order_value_usd*2) * 100, 1) AS whale_pct,
        ROUND(SUM(CASE WHEN order_value_usd*2 >= 1000 AND order_value_usd*2 < 20000 THEN order_value_usd*2 ELSE 0 END) / SUM(order_value_usd*2) * 100, 1) AS mid_pct,
        ROUND(SUM(CASE WHEN order_value_usd*2 < 1000 THEN order_value_usd*2 ELSE 0 END) / SUM(order_value_usd*2) * 100, 1) AS retail_pct
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE
    `).get(symbol) as any;

    // ── 6. TEMPORAL ──
    const daily = db.prepare(`
      SELECT DATE(created_at) AS day, ROUND(SUM(order_value_usd)*2, 0) AS vol
      FROM _order_flat WHERE token_symbol = ? COLLATE NOCASE GROUP BY day ORDER BY day
    `).all(symbol) as any[];
    const vols = daily.map((d: any) => d.vol);
    const avgDaily = vols.length > 0 ? vols.reduce((a: number, b: number) => a + b, 0) / vols.length : 0;
    const maxDaily = Math.max(...vols, 0);
    const spikeRatio = avgDaily > 0 ? Math.round(maxDaily / avgDaily * 10) / 10 : 0;
    const peakDays = daily.sort((a: any, b: any) => b.vol - a.vol).slice(0, 5).map((d: any) => ({
      day: d.day, vol: d.vol, pct: Math.round(d.vol / totalVol * 1000) / 10,
    }));

    // ── 7. RED FLAGS ──
    const redFlags: string[] = [];
    if (top10Pct > 70) redFlags.push(`Top 10 wallets control ${top10Pct}% volume — critical concentration`);
    else if (top10Pct > 50) redFlags.push(`Top 10 wallets control ${top10Pct}% volume — high concentration`);
    if (classification.dumperVol > classification.accumulatorVol * 2) redFlags.push(`Dumper volume (${moneySmart(classification.dumperVol)}) >> Accumulator volume — heavy sell pressure`);
    if (resalePct > 30) redFlags.push(`Resale rate ${resalePct}% — extreme speculation`);
    else if (resalePct > 25) redFlags.push(`Resale rate ${resalePct}% — elevated speculation`);
    if (newUserPct > 70) redFlags.push(`${newUserPct}% new users — potential pump scheme pattern`);
    if (sizes.whale_pct > 60) redFlags.push(`Whale orders (>$20K) = ${sizes.whale_pct}% volume — not retail-friendly`);
    if (sizes.retail_pct < 15) redFlags.push(`Retail (<$1K) = only ${sizes.retail_pct}% — no retail base`);
    if (spikeRatio > 10) redFlags.push(`Peak day is ${spikeRatio}x average — coordinated pump signal`);
    if (highResaleWallets > 3) redFlags.push(`${highResaleWallets} wallets with >50% resale rate`);

    // ── 8. RISK SCORE ──
    let riskScore = 0;
    if (top10Pct > 70) riskScore += 25; else if (top10Pct > 50) riskScore += 15;
    if (classification.dumpers > classification.accumulators + classification.marketMakers) riskScore += 20;
    if (resalePct > 30) riskScore += 15; else if (resalePct > 20) riskScore += 10;
    if (newUserPct > 70) riskScore += 15; else if (newUserPct > 50) riskScore += 5;
    if (sizes.whale_pct > 60) riskScore += 10;
    if (spikeRatio > 10) riskScore += 15; else if (spikeRatio > 5) riskScore += 5;
    riskScore = Math.min(riskScore, 100);

    const riskLevel = riskScore >= 70 ? "Critical" : riskScore >= 50 ? "High" : riskScore >= 30 ? "Medium" : "Low";

    // Top wallets
    const topWallets = classified.slice(0, 15).map((w: any) => ({
      address: w.address ? `${w.address.slice(0, 6)}...${w.address.slice(-4)}` : "?",
      vol: w.vol, orders: w.ord, avgSize: w.avg_size,
      buyPct: Math.round(w.buy_r * 100), resalePct: w.resale,
      type: w.wtype, period: `${w.first_d} → ${w.last_d}`,
    }));

    return {
      symbol: sym, totalVolume: totalVol, totalOrders: totals.ord, totalWallets: totalWallets.c,
      top10Pct, top20Pct, top50Pct,
      concentrationLevel: top10Pct > 70 ? "Critical" : top10Pct > 50 ? "High" : "Normal",
      classification, dominantBehavior,
      resalePct, resaleLevel: resalePct > 30 ? "Critical" : resalePct > 25 ? "High" : resalePct > 10 ? "Elevated" : "Normal",
      highResaleWallets,
      newUserPct, userQuality: newUserPct > 70 ? "Suspicious" : newUserPct > 50 ? "Mixed" : "Organic",
      whaleVolPct: sizes.whale_pct || 0, midVolPct: sizes.mid_pct || 0, retailVolPct: sizes.retail_pct || 0,
      retailLevel: sizes.retail_pct < 15 ? "No retail base" : sizes.retail_pct < 30 ? "Weak retail" : "Healthy retail",
      peakDays, avgDailyVol: Math.round(avgDaily), maxDailyVol: maxDaily,
      spikeRatio, isOrganic: spikeRatio < 5,
      redFlags, riskLevel, riskScore, topWallets,
    };
  } finally {
    db.close();
  }
}

export function formatForensic(r: ForensicReport): string {
  const L: string[] = [];
  const riskIcon = r.riskLevel === "Critical" ? "🔴" : r.riskLevel === "High" ? "🟠" : r.riskLevel === "Medium" ? "🟡" : "🟢";
  const typeIcon: Record<string, string> = { "Market Maker": "🔵", "Accumulator": "🟢", "Dumper": "🔴", "Flipper": "🟡", "Trader": "⚪" };

  L.push(`<b>🔍 $${r.symbol} TRADER FORENSIC</b>`);
  L.push(`${moneySmart(r.totalVolume)} vol · ${r.totalOrders} orders · ${r.totalWallets} wallets`);
  L.push(``);

  // Risk score
  L.push(`${riskIcon} <b>Risk: ${r.riskLevel}</b> (${r.riskScore}/100)`);
  L.push(``);

  // Concentration
  L.push(`<b>1. CONCENTRATION</b>`);
  L.push(`Top 10: <b>${r.top10Pct}%</b> · Top 20: ${r.top20Pct}% · Top 50: ${r.top50Pct}%`);
  L.push(``);

  // Classification
  L.push(`<b>2. BEHAVIOR</b>  →  ${r.dominantBehavior}`);
  const types = [
    { n: "Dumper", c: r.classification.dumpers, v: r.classification.dumperVol },
    { n: "Accumulator", c: r.classification.accumulators, v: r.classification.accumulatorVol },
    { n: "Market Maker", c: r.classification.marketMakers, v: r.classification.mmVol },
    { n: "Flipper", c: r.classification.flippers, v: r.classification.flipperVol },
  ].filter(t => t.c > 0);
  L.push(types.map(t => `${typeIcon[t.n]}${t.n} ${t.c} (${moneySmart(t.v)})`).join("\n"));
  L.push(``);

  // Speculation + Users + Order size
  L.push(`<b>3. METRICS</b>`);
  L.push(`Resale: <b>${r.resalePct}%</b> (${r.resaleLevel}) · New Users: <b>${r.newUserPct}%</b> (${r.userQuality})`);
  L.push(`Whale >$20K: ${r.whaleVolPct}% · Mid: ${r.midVolPct}% · Retail <$1K: ${r.retailVolPct}%`);
  L.push(``);

  // Temporal
  L.push(`<b>4. PATTERN</b>  ${r.isOrganic ? "Organic" : "Spike-driven"}`);
  L.push(`Avg daily: ${moneySmart(r.avgDailyVol)} · Peak: ${moneySmart(r.maxDailyVol)} (${r.spikeRatio}x)`);
  L.push(``);

  // Red flags
  if (r.redFlags.length > 0) {
    L.push(`<b>5. RED FLAGS</b>`);
    r.redFlags.forEach(f => L.push(`⚠️ ${f}`));
    L.push(``);
  }

  // Top 5 wallets
  L.push(`<b>TOP WALLETS</b>`);
  r.topWallets.slice(0, 5).forEach((w, i) => {
    L.push(`${i + 1}. <b>${w.address}</b> ${typeIcon[w.type] || "⚪"} ${w.type}`);
    L.push(`   ${moneySmart(w.vol)} · ${w.orders} ord · Buy ${w.buyPct}%${w.resalePct > 0 ? ` · RS ${w.resalePct}%` : ""}`);
  });

  return L.join("\n");
}
