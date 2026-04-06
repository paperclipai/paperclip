// html-report-builder.ts
// Build topic-specific HTML reports with Chart.js + dark theme
// Rendered to PNG by Puppeteer in context-chart.ts

import Database from "better-sqlite3";

// ============================================================
// SHARED CSS — YOM dark theme
// ============================================================

const CSS = `
:root {
  --bg: #0a0b0f; --bg2: #12131a; --card: #181924; --border: #2a2c3e;
  --t1: #e8e9f0; --t2: #8b8da3; --t3: #5c5e73;
  --cyan: #00e5ff; --cyand: #00e5ff33;
  --green: #00ff88; --greend: #00ff8833;
  --orange: #ff9d00; --oranged: #ff9d0033;
  --red: #ff3b5c; --redd: #ff3b5c33;
  --purple: #a78bfa; --purpled: #a78bfa33;
  --yellow: #fbbf24; --yellowd: #fbbf2433;
  --pink: #f472b6; --pinkd: #f472b633;
  --acc: linear-gradient(135deg, #6366F1, #22D3EE);
  --r: 12px; --rs: 8px;
  --sh: 0 4px 24px rgba(0,0,0,.4);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Sora', sans-serif;
  background: var(--bg); color: var(--t1);
  width: 800px; padding: 28px;
}
.hd { text-align: center; margin-bottom: 32px; position: relative; }
.hd::after { content: ''; position: absolute; bottom: -16px; left: 50%; transform: translateX(-50%); width: 120px; height: 2px; background: var(--acc); border-radius: 2px; }
.badge { display: inline-block; font-family: 'Space Mono', monospace; font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #6366F1; background: #6366F122; border: 1px solid #6366F1; border-radius: 100px; padding: 5px 16px; margin-bottom: 12px; }
.hd h1 { font-size: 24px; font-weight: 800; letter-spacing: -.5px; margin-bottom: 4px; background: var(--acc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hd p { color: var(--t2); font-size: 13px; }
.kf { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
.kfc { background: var(--card); border: 1px solid var(--border); border-radius: var(--rs); padding: 14px; text-align: center; }
.kft { font-size: 9px; font-family: 'Space Mono', monospace; letter-spacing: 1px; color: var(--t3); text-transform: uppercase; margin-bottom: 4px; }
.kfv { font-size: 18px; font-weight: 700; }
.kfc .change { font-size: 11px; margin-top: 2px; }
.sec { background: var(--card); border: 1px solid var(--border); border-radius: var(--r); padding: 24px; margin-bottom: 20px; box-shadow: var(--sh); position: relative; overflow: hidden; }
.sec::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
.sec.cy::before { background: var(--cyan); } .sec.gn::before { background: var(--green); }
.sec.or::before { background: var(--orange); } .sec.pu::before { background: var(--purple); }
.sec.rd::before { background: var(--red); } .sec.yl::before { background: var(--yellow); }
.sec.pk::before { background: var(--pink); }
.sh { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.si { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; }
.sec.cy .si { background: var(--cyand); } .sec.gn .si { background: var(--greend); }
.sec.or .si { background: var(--oranged); } .sec.pu .si { background: var(--purpled); }
.sec.rd .si { background: var(--redd); } .sec.yl .si { background: var(--yellowd); }
.stt { font-size: 16px; font-weight: 700; }
.sw { font-family: 'Space Mono', monospace; font-size: 10px; letter-spacing: 1px; padding: 3px 10px; border-radius: 100px; margin-left: auto; }
.sec.cy .sw { color: var(--cyan); background: var(--cyand); }
.sec.gn .sw { color: var(--green); background: var(--greend); }
.sec.or .sw { color: var(--orange); background: var(--oranged); }
.sec.pu .sw { color: var(--purple); background: var(--purpled); }
.sec.rd .sw { color: var(--red); background: var(--redd); }
.bt { width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0; }
.bt th { font-family: 'Space Mono', monospace; font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--t3); text-align: left; padding: 8px 6px; border-bottom: 2px solid var(--border); white-space: nowrap; }
.bt td { padding: 8px 6px; border-bottom: 1px solid var(--border); color: var(--t2); }
.bt tr:last-child td { border-bottom: none; }
.bt .nm { color: var(--t1); font-weight: 600; }
.bt .g { color: var(--green); } .bt .r { color: var(--red); } .bt .o { color: var(--orange); } .bt .cy { color: var(--cyan); }
.an { margin-top: 16px; padding: 14px; background: var(--bg2); border-radius: var(--rs); border-left: 3px solid var(--cyan); }
.sec.gn .an { border-left-color: var(--green); } .sec.or .an { border-left-color: var(--orange); }
.sec.pu .an { border-left-color: var(--purple); } .sec.rd .an { border-left-color: var(--red); }
.ant { font-family: 'Space Mono', monospace; font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--t3); margin-bottom: 6px; }
.an ul { list-style: none; padding: 0; }
.an ul li { font-size: 12px; color: var(--t2); line-height: 1.7; padding: 2px 0 2px 14px; position: relative; }
.an ul li::before { content: '\\2192'; position: absolute; left: 0; color: var(--cyan); }
.sec.gn .an ul li::before { color: var(--green); }
.sec.or .an ul li::before { color: var(--orange); }
.sec.pu .an ul li::before { color: var(--purple); }
canvas { max-width: 100%; }
.chart-box { margin: 12px 0; }
.pg { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 12px 0; }
`;

// ============================================================
// COMPONENT HELPERS
// ============================================================

export function fmtUSD(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtNum(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString();
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function pctBadge(cur: number, prev: number): string {
  if (!prev) return "";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  const color = pct >= 0 ? "var(--green)" : "var(--red)";
  return `<span class="change" style="color:${color}">${sign}${pct.toFixed(1)}%</span>`;
}

function rateColor(rate: number): string {
  if (rate >= 80) return "var(--green)";
  if (rate >= 50) return "var(--yellow)";
  return "var(--red)";
}

/** Header with badge + gradient title */
export function header(title: string, subtitle: string, badgeText: string): string {
  return `<div class="hd">
  <div class="badge">${badgeText}</div>
  <h1>${title}</h1>
  <p>${subtitle}</p>
</div>`;
}

/** KPI card grid */
export function kpiGrid(cards: Array<{ label: string; value: string; color?: string; change?: string }>): string {
  return `<div class="kf">${cards.map(c =>
    `<div class="kfc">
      <div class="kft">${c.label}</div>
      <div class="kfv" style="color:${c.color ?? 'var(--t1)'}">${c.value}</div>
      ${c.change ? `<div class="change">${c.change}</div>` : ""}
    </div>`
  ).join("")}</div>`;
}

/** Section wrapper with colored top border */
export function section(color: string, icon: string, title: string, badge: string, content: string): string {
  return `<div class="sec ${color}">
  <div class="sh">
    <div class="si">${icon}</div>
    <div class="stt">${title}</div>
    <div class="sw">${badge}</div>
  </div>
  ${content}
</div>`;
}

/** Data table */
export function dataTable(headers: string[], rows: string[][]): string {
  return `<table class="bt">
  <thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
</table>`;
}

/** Analysis box with bullet points */
export function analysisBox(points: string[]): string {
  if (points.length === 0) return "";
  return `<div class="an">
  <div class="ant">Analysis</div>
  <ul>${points.map(p => `<li>${p}</li>`).join("")}</ul>
</div>`;
}

/** Canvas placeholder for Chart.js (rendered in <script>) */
export function chartCanvas(id: string, height = 200): string {
  return `<div class="chart-box"><canvas id="${id}" height="${height}"></canvas></div>`;
}

/** Full HTML page wrapper */
export function htmlPage(title: string, bodyContent: string, chartScripts: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Sora:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>${CSS}</style>
</head>
<body>
${bodyContent}
<script>
Chart.defaults.color = '#8b8da3';
Chart.defaults.borderColor = '#2a2c3e';
Chart.defaults.font.family = "'Space Mono', monospace";
Chart.defaults.font.size = 10;
${chartScripts}
</script>
</body>
</html>`;
}

// ============================================================
// LAYOUT 1: OVERVIEW (top-tokens, volume, settle)
// ============================================================

function queryOverviewData(db: Database.Database) {
  // Top tokens by volume (2-sided, include exit)
  const tokens = db.prepare(`
    SELECT
      of2.token_symbol AS symbol,
      ROUND(SUM(of2.order_value_usd_1side) * 2, 0) AS volume,
      COUNT(DISTINCT of2.order_id) AS orders,
      COUNT(DISTINCT of2.buyer_id) + COUNT(DISTINCT of2.seller_id) AS traders,
      ROUND(AVG(of2.order_value_usd_1side) * 2, 0) AS avgOrder
    FROM _order_flat of2
    GROUP BY of2.token_symbol
    ORDER BY volume DESC
    LIMIT 12
  `).all() as Array<{ symbol: string; volume: number; orders: number; traders: number; avgOrder: number }>;

  // Offer values from token table
  const offerMap = new Map<string, number>();
  const statusMap = new Map<string, string>();
  for (const t of tokens) {
    const row = db.prepare(`
      SELECT
        COALESCE(total_volume_ask, 0) + COALESCE(total_volume_bid, 0) AS offer_value,
        status
      FROM token WHERE symbol = ? LIMIT 1
    `).get(t.symbol) as { offer_value: number; status: string } | undefined;
    offerMap.set(t.symbol, row?.offer_value ?? 0);
    statusMap.set(t.symbol, row?.status ?? "unknown");
  }

  // Settlement rates per token
  const settleRows = db.prepare(`
    SELECT token_symbol AS symbol,
      ROUND(COUNT(DISTINCT CASE WHEN status = 'close' THEN order_id END) * 100.0 /
        NULLIF(COUNT(DISTINCT CASE WHEN status IN ('close','cancel') THEN order_id END), 0), 1) AS rate
    FROM _order_flat
    GROUP BY token_symbol
  `).all() as Array<{ symbol: string; rate: number }>;
  const settleMap = new Map(settleRows.map(r => [r.symbol, r.rate ?? 0]));

  // Exit position % per token
  const exitRows = db.prepare(`
    SELECT token_symbol AS symbol,
      ROUND(COUNT(DISTINCT CASE WHEN is_exit_position = 1 THEN order_id END) * 100.0 /
        NULLIF(COUNT(DISTINCT order_id), 0), 1) AS exitPct
    FROM _order_flat
    GROUP BY token_symbol
  `).all() as Array<{ symbol: string; exitPct: number }>;
  const exitMap = new Map(exitRows.map(r => [r.symbol, r.exitPct ?? 0]));

  // Whale concentration (top 5 wallets % of volume per token)
  const whaleRows = db.prepare(`
    WITH wallet_vol AS (
      SELECT token_symbol, buyer_id AS uid, SUM(order_value_usd_1side) AS vol
      FROM _order_flat GROUP BY token_symbol, buyer_id
      UNION ALL
      SELECT token_symbol, seller_id, SUM(order_value_usd_1side)
      FROM _order_flat GROUP BY token_symbol, seller_id
    ), ranked AS (
      SELECT token_symbol, uid, SUM(vol) AS total_vol,
        ROW_NUMBER() OVER (PARTITION BY token_symbol ORDER BY SUM(vol) DESC) AS rn
      FROM wallet_vol GROUP BY token_symbol, uid
    ), token_total AS (
      SELECT token_symbol, SUM(total_vol) AS tv FROM ranked GROUP BY token_symbol
    )
    SELECT r.token_symbol AS symbol,
      ROUND(SUM(r.total_vol) * 100.0 / NULLIF(tt.tv, 0), 1) AS whaleConc
    FROM ranked r JOIN token_total tt ON r.token_symbol = tt.token_symbol
    WHERE r.rn <= 5
    GROUP BY r.token_symbol
  `).all() as Array<{ symbol: string; whaleConc: number }>;
  const whaleMap = new Map(whaleRows.map(r => [r.symbol, r.whaleConc ?? 0]));

  // Lifespan per token
  const lifespanRows = db.prepare(`
    SELECT token_symbol AS symbol,
      CAST(JULIANDAY(MAX(created_at)) - JULIANDAY(MIN(created_at)) AS INTEGER) AS days
    FROM _order_flat
    GROUP BY token_symbol
  `).all() as Array<{ symbol: string; days: number }>;
  const lifespanMap = new Map(lifespanRows.map(r => [r.symbol, r.days ?? 0]));

  const enriched = tokens.map(t => ({
    symbol: t.symbol,
    volume: t.volume,
    offerValue: offerMap.get(t.symbol) ?? 0,
    fillPct: offerMap.get(t.symbol) ? (t.volume / (offerMap.get(t.symbol)!) * 100) : 0,
    orders: t.orders,
    traders: t.traders,
    settlePct: settleMap.get(t.symbol) ?? 0,
    exitPct: exitMap.get(t.symbol) ?? 0,
    avgOrder: t.avgOrder,
    whaleConc: whaleMap.get(t.symbol) ?? 0,
    lifespan: `${lifespanMap.get(t.symbol) ?? 0}d`,
    status: statusMap.get(t.symbol) ?? "unknown",
  }));

  const totalVolume = enriched.reduce((s, t) => s + t.volume, 0);
  const totalOfferValue = enriched.reduce((s, t) => s + t.offerValue, 0);

  return {
    tokens: enriched,
    totalVolume,
    totalOfferValue,
    avgFillRate: totalOfferValue ? (totalVolume / totalOfferValue * 100) : 0,
    activeTokens: enriched.filter(t => t.status === "active").length,
  };
}

export function overviewLayout(db: Database.Database): string {
  const d = queryOverviewData(db);
  const today = new Date().toISOString().slice(0, 10);

  const platformSettle = db.prepare(`
    SELECT ROUND(COUNT(DISTINCT CASE WHEN status = 'close' THEN order_id END) * 100.0 /
      NULLIF(COUNT(DISTINCT CASE WHEN status IN ('close','cancel') THEN order_id END), 0), 1) AS rate
    FROM _order_flat
  `).get() as { rate: number };

  const body = [
    header("Platform Overview", `All-time metrics \u2022 ${today}`, "Whales Market"),
    kpiGrid([
      { label: "Total Volume", value: fmtUSD(d.totalVolume), color: "var(--cyan)" },
      { label: "Total Offer Value", value: fmtUSD(d.totalOfferValue), color: "var(--purple)" },
      { label: "Avg Fill Rate", value: fmtPct(d.avgFillRate), color: d.avgFillRate > 50 ? "var(--green)" : "var(--orange)" },
      { label: "Settle Rate", value: fmtPct(platformSettle.rate ?? 0), color: rateColor(platformSettle.rate ?? 0) },
      { label: "Active Tokens", value: String(d.activeTokens), color: "var(--yellow)" },
    ]),

    section("cy", "\uD83D\uDCCA", "Volume Ranking", `TOP ${d.tokens.length}`,
      chartCanvas("volumeChart", 280) +
      dataTable(
        ["Token", "Volume", "Offer Value", "Fill %", "Orders"],
        d.tokens.slice(0, 10).map(t => [
          `<span class="nm">$${t.symbol}</span>`,
          `<span class="cy">${fmtUSD(t.volume)}</span>`,
          fmtUSD(t.offerValue),
          `<span style="color:${t.fillPct > 50 ? 'var(--green)' : 'var(--orange)'}">${fmtPct(t.fillPct)}</span>`,
          fmtNum(t.orders),
        ])
      ) +
      analysisBox([
        `Top token $${d.tokens[0]?.symbol} accounts for ${d.totalVolume ? (d.tokens[0]?.volume / d.totalVolume * 100).toFixed(1) : 0}% of total volume`,
        `Average fill rate across top tokens: ${fmtPct(d.avgFillRate)}`,
        d.tokens.filter(t => t.fillPct > 70).length > 0
          ? `${d.tokens.filter(t => t.fillPct > 70).length} tokens have fill rate >70%`
          : `No tokens exceed 70% fill rate \u2014 market has significant unfilled offers`,
      ])
    ),

    section("gn", "\u2696\uFE0F", "Settlement Health", fmtPct(platformSettle.rate ?? 0),
      chartCanvas("settleChart", 260) +
      dataTable(
        ["Token", "Settle Rate", "Exit %", "Status"],
        d.tokens.slice(0, 10).map(t => [
          `<span class="nm">$${t.symbol}</span>`,
          `<span style="color:${rateColor(t.settlePct)}">${fmtPct(t.settlePct)}</span>`,
          `${fmtPct(t.exitPct)}`,
          `<span style="color:${t.status === 'active' ? 'var(--green)' : 'var(--t3)'}">${t.status}</span>`,
        ])
      ) +
      analysisBox([
        `Platform settle rate: ${fmtPct(platformSettle.rate ?? 0)}`,
        `${d.tokens.filter(t => t.settlePct < 70).length} tokens below 70% settle threshold`,
        `${d.tokens.filter(t => t.exitPct > 10).length} tokens have >10% exit positions`,
      ])
    ),

    section("pu", "\uD83D\uDD0D", "Token Patterns", `${d.tokens.length} TOKENS`,
      dataTable(
        ["Token", "Avg Order", "Traders", "Exit%", "Whale%", "Life", "Status"],
        d.tokens.slice(0, 10).map(t => [
          `<span class="nm">$${t.symbol}</span>`,
          fmtUSD(t.avgOrder),
          fmtNum(t.traders),
          fmtPct(t.exitPct),
          `<span style="color:${t.whaleConc > 50 ? 'var(--red)' : 'var(--t2)'}">${fmtPct(t.whaleConc)}</span>`,
          t.lifespan,
          `<span style="color:${t.status === 'active' ? 'var(--green)' : 'var(--t3)'}">${t.status}</span>`,
        ])
      ) +
      analysisBox([
        d.tokens.filter(t => t.whaleConc > 60).length > 0
          ? `\u26A0 ${d.tokens.filter(t => t.whaleConc > 60).length} tokens have whale concentration >60%`
          : `No extreme whale concentration detected`,
        `Avg order size ranges from ${fmtUSD(Math.min(...d.tokens.map(t => t.avgOrder)))} to ${fmtUSD(Math.max(...d.tokens.map(t => t.avgOrder)))}`,
      ])
    ),
  ].join("\n");

  const charts = `
new Chart(document.getElementById('volumeChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(d.tokens.slice(0, 10).map(t => '$' + t.symbol))},
    datasets: [{
      label: 'Volume (USD)', data: ${JSON.stringify(d.tokens.slice(0, 10).map(t => Math.round(t.volume)))},
      backgroundColor: '#00e5ff88', borderRadius: 4
    }]
  },
  options: { indexAxis: 'y', scales: { x: { ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } } }, plugins: { legend: { display: false } } }
});
new Chart(document.getElementById('settleChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(d.tokens.slice(0, 10).map(t => '$' + t.symbol))},
    datasets: [{
      label: 'Settle Rate %', data: ${JSON.stringify(d.tokens.slice(0, 10).map(t => t.settlePct))},
      backgroundColor: ${JSON.stringify(d.tokens.slice(0, 10).map(t => t.settlePct >= 80 ? '#00ff8888' : t.settlePct >= 50 ? '#fbbf2488' : '#ff3b5c88'))},
      borderRadius: 4
    }]
  },
  options: { indexAxis: 'y', scales: { x: { min: 0, max: 100 } }, plugins: { legend: { display: false } } }
});`;

  return htmlPage("Platform Overview", body, charts);
}

// ============================================================
// LAYOUT 2: SINGLE ENTITY (token-{X})
// ============================================================

export function singleTokenLayout(db: Database.Database, symbol: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const sym = symbol.toUpperCase();

  const vol = db.prepare(`
    SELECT
      ROUND(SUM(order_value_usd_1side) * 2, 0) AS volume_all,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN order_value_usd_1side ELSE 0 END) * 2, 0) AS volume_7d,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN order_value_usd_1side ELSE 0 END) * 2, 0) AS volume_30d,
      COUNT(DISTINCT order_id) AS orders
    FROM _order_flat WHERE token_symbol = ?
  `).get(sym) as { volume_all: number; volume_7d: number; volume_30d: number; orders: number };

  const tokenInfo = db.prepare(`
    SELECT COALESCE(total_volume_ask,0)+COALESCE(total_volume_bid,0) AS offer_value, status
    FROM token WHERE symbol = ? LIMIT 1
  `).get(sym) as { offer_value: number; status: string } | undefined;
  const offerValue = tokenInfo?.offer_value ?? 0;
  const fillRate = offerValue ? (vol.volume_all / offerValue * 100) : 0;

  const settle = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN status = 'close' THEN order_id END) AS settled,
      COUNT(DISTINCT CASE WHEN status = 'cancel' THEN order_id END) AS cancelled,
      COUNT(DISTINCT CASE WHEN status IN ('close','cancel') THEN order_id END) AS total
    FROM _order_flat WHERE token_symbol = ?
  `).get(sym) as { settled: number; cancelled: number; total: number };
  const settleRate = settle.total ? (settle.settled / settle.total * 100) : 0;

  const exit = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN is_exit_position = 1 THEN order_id END) AS exits,
      COUNT(DISTINCT order_id) AS total
    FROM _order_flat WHERE token_symbol = ?
  `).get(sym) as { exits: number; total: number };
  const exitPct = exit.total ? (exit.exits / exit.total * 100) : 0;

  // 3-way user classification: new to platform, new to this token, returning
  const tokenId = db.prepare(
    `SELECT id FROM token WHERE symbol = ? AND deleted_at IS NULL LIMIT 1`
  ).get(sym) as { id: string } | undefined;
  const traders = db.prepare(`
    WITH w AS (
      SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE token_symbol = ?
      UNION SELECT DISTINCT seller_id FROM _order_flat WHERE token_symbol = ?
    )
    SELECT
      COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now','-30 days')
        THEN w.uid END) AS new_platform,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now','-30 days')
        AND utf.first_token_order_at >= datetime('now','-30 days')
        THEN w.uid END) AS new_token,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now','-30 days')
        AND (utf.first_token_order_at IS NULL OR utf.first_token_order_at < datetime('now','-30 days'))
        THEN w.uid END) AS ret_users
    FROM w
    LEFT JOIN _user_first_order ufo ON w.uid = ufo.user_id
    LEFT JOIN _user_token_first utf ON w.uid = utf.user_id AND utf.token_id = ?
  `).get(sym, sym, tokenId?.id ?? "") as { new_platform: number; new_token: number; ret_users: number };

  const trend = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at) AS date,
      ROUND(SUM(order_value_usd_1side) * 2, 0) AS volume,
      COUNT(DISTINCT order_id) AS orders
    FROM _order_flat WHERE token_symbol = ?
    GROUP BY date ORDER BY date
  `).all(sym) as Array<{ date: string; volume: number; orders: number }>;

  const topWallets = db.prepare(`
    WITH wv AS (
      SELECT buyer_id AS uid, SUM(order_value_usd_1side)*2 AS vol FROM _order_flat WHERE token_symbol = ? GROUP BY buyer_id
      UNION ALL
      SELECT seller_id, SUM(order_value_usd_1side)*2 FROM _order_flat WHERE token_symbol = ? GROUP BY seller_id
    )
    SELECT uid, ROUND(SUM(vol),0) AS volume FROM wv GROUP BY uid ORDER BY volume DESC LIMIT 10
  `).all(sym, sym) as Array<{ uid: string; volume: number }>;
  const top5Pct = vol.volume_all ? (topWallets.slice(0, 5).reduce((s, w) => s + w.volume, 0) / vol.volume_all * 100) : 0;

  const body = [
    header(`$${sym} Analysis`, `${tokenInfo?.status ?? "unknown"} \u2022 ${today}`, "Single Token"),
    kpiGrid([
      { label: "Volume (All)", value: fmtUSD(vol.volume_all), color: "var(--cyan)" },
      { label: "Offer Value", value: fmtUSD(offerValue), color: "var(--purple)" },
      { label: "Fill Rate", value: fmtPct(fillRate), color: fillRate > 50 ? "var(--green)" : "var(--orange)" },
      { label: "Settle Rate", value: fmtPct(settleRate), color: rateColor(settleRate) },
      { label: "Exit %", value: fmtPct(exitPct), color: exitPct > 10 ? "var(--orange)" : "var(--t1)" },
    ]),

    section("cy", "\uD83D\uDCC8", "Volume Timeline", `${trend.length} days`,
      chartCanvas("trendChart", 220) +
      analysisBox([
        `7d volume: ${fmtUSD(vol.volume_7d)} \u2022 30d: ${fmtUSD(vol.volume_30d)} \u2022 All-time: ${fmtUSD(vol.volume_all)}`,
        `${vol.orders} total orders`,
      ])
    ),

    section("gn", "\uD83D\uDC65", "Traders", `${traders.new_platform + traders.new_token + traders.ret_users} total`,
      `<div class="pg">
        <div>${chartCanvas("traderChart", 180)}</div>
        <div>${dataTable(
          ["Metric", "Value"],
          [
            ["New to Platform (30d)", `<span class="g">${traders.new_platform}</span>`],
            ["New to $${sym}", `<span class="o">${traders.new_token}</span>`],
            ["Returning", `<span class="cy">${traders.ret_users}</span>`],
            ["Platform Acq. Rate", `${(traders.new_platform + traders.new_token + traders.ret_users) ? fmtPct(traders.new_platform / (traders.new_platform + traders.new_token + traders.ret_users) * 100) : "0%"}`],
          ]
        )}</div>
      </div>`
    ),

    section("or", "\uD83D\uDC0B", "Whale Concentration", `Top 5: ${fmtPct(top5Pct)}`,
      dataTable(
        ["#", "Wallet", "Volume", "Share"],
        topWallets.slice(0, 10).map((w, i) => [
          `${i + 1}`,
          `<span class="nm">${w.uid.slice(0, 8)}...</span>`,
          `<span class="cy">${fmtUSD(w.volume)}</span>`,
          `${vol.volume_all ? fmtPct(w.volume / vol.volume_all * 100) : "0%"}`,
        ])
      ) +
      analysisBox([
        `Top 5 wallets hold ${fmtPct(top5Pct)} of $${sym} volume`,
        top5Pct > 60 ? `\u26A0 High whale concentration \u2014 risk of price manipulation` : `Healthy distribution across traders`,
      ])
    ),

    section(settleRate >= 70 ? "gn" : "rd", "\u2696\uFE0F", "Settlement", fmtPct(settleRate),
      dataTable(
        ["Metric", "Value"],
        [
          ["Settled Orders", `<span class="g">${settle.settled}</span>`],
          ["Cancelled Orders", `<span class="r">${settle.cancelled}</span>`],
          ["Settlement Rate", `<span style="color:${rateColor(settleRate)}">${fmtPct(settleRate)}</span>`],
          ["Exit Positions", `${exit.exits} (${fmtPct(exitPct)})`],
        ]
      ) +
      analysisBox([
        settleRate >= 80 ? `Strong settlement performance` :
        settleRate >= 50 ? `Settlement rate below target (80%)` :
        `\u26A0 Critical: settlement rate below 50%`,
        `${exit.exits} exit positions (${fmtPct(exitPct)}) \u2014 traders exiting before TGE`,
      ])
    ),
  ].join("\n");

  const trendSlice = trend.slice(-30);
  const charts = `
new Chart(document.getElementById('trendChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(trendSlice.map(d => d.date.slice(5)))},
    datasets: [
      { label: 'Volume', data: ${JSON.stringify(trendSlice.map(d => d.volume))}, borderColor: '#00e5ff', backgroundColor: '#00e5ff22', fill: true, tension: 0.3 },
      { label: 'Orders', data: ${JSON.stringify(trendSlice.map(d => d.orders))}, borderColor: '#f472b6', fill: false, tension: 0.3, yAxisID: 'y1' }
    ]
  },
  options: {
    scales: {
      y: { position: 'left', ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } },
      y1: { position: 'right', grid: { drawOnChartArea: false } }
    }
  }
});
new Chart(document.getElementById('traderChart'), {
  type: 'doughnut',
  data: {
    labels: ['New Platform', 'New Token', 'Returning'],
    datasets: [{ data: [${traders.new_platform}, ${traders.new_token}, ${traders.ret_users}], backgroundColor: ['#00ff88', '#ff9d00', '#a78bfa'], borderWidth: 0 }]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});`;

  return htmlPage(`$${sym} Analysis`, body, charts);
}

// ============================================================
// LAYOUT 3: COMPARISON (trend, users, mom)
// ============================================================

export function trendLayout(db: Database.Database): string {
  const today = new Date().toISOString().slice(0, 10);

  const daily = db.prepare(`
    SELECT DATE(created_at) AS date,
      ROUND(SUM(order_value_usd_1side) * 2, 0) AS volume,
      COUNT(DISTINCT order_id) AS orders,
      COUNT(DISTINCT buyer_id) + COUNT(DISTINCT seller_id) AS wallets
    FROM _order_flat
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY DATE(created_at) ORDER BY date
  `).all() as Array<{ date: string; volume: number; orders: number; wallets: number }>;

  const cur7d = db.prepare(`SELECT ROUND(SUM(order_value_usd_1side)*2,0) AS v, COUNT(DISTINCT order_id) AS o,
    COUNT(DISTINCT buyer_id)+COUNT(DISTINCT seller_id) AS w
    FROM _order_flat WHERE created_at >= datetime('now','-7 days')`).get() as any;
  const prev7d = db.prepare(`SELECT ROUND(SUM(order_value_usd_1side)*2,0) AS v, COUNT(DISTINCT order_id) AS o,
    COUNT(DISTINCT buyer_id)+COUNT(DISTINCT seller_id) AS w
    FROM _order_flat WHERE created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')`).get() as any;

  const users = db.prepare(`
    WITH w AS (
      SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now','-7 days')
      UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= datetime('now','-7 days')
    )
    SELECT
      COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now','-7 days') THEN w.uid END) AS new_users,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now','-7 days') THEN w.uid END) AS ret_users
    FROM w LEFT JOIN _user_first_order ufo ON w.uid = ufo.user_id
  `).get() as { new_users: number; ret_users: number };

  const movers = db.prepare(`
    SELECT token_symbol AS symbol,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN order_value_usd_1side ELSE 0 END)*2, 0) AS cur,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days') THEN order_value_usd_1side ELSE 0 END)*2, 0) AS prev
    FROM _order_flat
    GROUP BY token_symbol
    HAVING cur > 0 OR prev > 0
    ORDER BY (cur - prev) DESC
  `).all() as Array<{ symbol: string; cur: number; prev: number }>;

  const gainers = movers.filter(m => m.cur > m.prev).slice(0, 5);
  const losers = movers.filter(m => m.cur < m.prev).slice(-5).reverse();

  const peak = daily.length > 0 ? daily.reduce((max, d) => d.volume > max.volume ? d : max, daily[0]) : null;
  const low = daily.length > 0 ? daily.reduce((min, d) => d.volume < min.volume ? d : min, daily[0]) : null;

  const body = [
    header("Trend & Comparison", `7-day WoW \u2022 ${today}`, "Comparison"),
    kpiGrid([
      { label: "Volume (7d)", value: fmtUSD(cur7d?.v ?? 0), color: "var(--cyan)", change: pctBadge(cur7d?.v ?? 0, prev7d?.v ?? 0) },
      { label: "Orders (7d)", value: fmtNum(cur7d?.o ?? 0), color: "var(--t1)", change: pctBadge(cur7d?.o ?? 0, prev7d?.o ?? 0) },
      { label: "Wallets (7d)", value: fmtNum(cur7d?.w ?? 0), color: "var(--purple)", change: pctBadge(cur7d?.w ?? 0, prev7d?.w ?? 0) },
      { label: "New Users (7d)", value: fmtNum(users.new_users), color: "var(--green)" },
      { label: "Acq. Rate", value: fmtPct((users.new_users + users.ret_users) ? users.new_users / (users.new_users + users.ret_users) * 100 : 0), color: "var(--yellow)" },
    ]),

    section("cy", "\uD83D\uDCC8", "Daily Trend", "14 DAYS",
      chartCanvas("dailyTrend", 240) +
      analysisBox([
        `Peak: ${peak?.date?.slice(5) ?? "N/A"} at ${fmtUSD(peak?.volume ?? 0)}`,
        `Low: ${low?.date?.slice(5) ?? "N/A"} at ${fmtUSD(low?.volume ?? 0)}`,
      ])
    ),

    section("pu", "\uD83D\uDD04", "Week-over-Week", "WOW",
      chartCanvas("wowChart", 200)
    ),

    section("gn", "\uD83D\uDE80", "Top Gainers", `${gainers.length} tokens`,
      dataTable(
        ["Token", "This Week", "Last Week", "Change"],
        gainers.map(m => {
          const pct = m.prev ? ((m.cur - m.prev) / m.prev * 100) : 100;
          return [
            `<span class="nm">$${m.symbol}</span>`,
            `<span class="cy">${fmtUSD(m.cur)}</span>`,
            fmtUSD(m.prev),
            `<span class="g">+${pct.toFixed(1)}%</span>`,
          ];
        })
      )
    ),

    section("rd", "\uD83D\uDCC9", "Top Losers", `${losers.length} tokens`,
      dataTable(
        ["Token", "This Week", "Last Week", "Change"],
        losers.map(m => {
          const pct = m.prev ? ((m.cur - m.prev) / m.prev * 100) : -100;
          return [
            `<span class="nm">$${m.symbol}</span>`,
            fmtUSD(m.cur),
            fmtUSD(m.prev),
            `<span class="r">${pct.toFixed(1)}%</span>`,
          ];
        })
      )
    ),
  ].join("\n");

  const charts = `
new Chart(document.getElementById('dailyTrend'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(daily.map(d => d.date.slice(5)))},
    datasets: [
      { label: 'Volume', data: ${JSON.stringify(daily.map(d => d.volume))}, borderColor: '#00e5ff', backgroundColor: '#00e5ff22', fill: true, tension: 0.3 },
      { label: 'Orders', data: ${JSON.stringify(daily.map(d => d.orders))}, borderColor: '#f472b6', fill: false, tension: 0.3, yAxisID: 'y1' }
    ]
  },
  options: {
    scales: {
      y: { position: 'left', ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } },
      y1: { position: 'right', grid: { drawOnChartArea: false } }
    }
  }
});
new Chart(document.getElementById('wowChart'), {
  type: 'bar',
  data: {
    labels: ['Volume', 'Orders', 'Wallets'],
    datasets: [
      { label: 'This Week', data: [${cur7d?.v ?? 0}, ${cur7d?.o ?? 0}, ${cur7d?.w ?? 0}], backgroundColor: '#00e5ff88', borderRadius: 4 },
      { label: 'Last Week', data: [${prev7d?.v ?? 0}, ${prev7d?.o ?? 0}, ${prev7d?.w ?? 0}], backgroundColor: '#8b8da355', borderRadius: 4 }
    ]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});`;

  return htmlPage("Trend & Comparison", body, charts);
}

export function usersLayout(db: Database.Database): string {
  const today = new Date().toISOString().slice(0, 10);

  // 3-way: new to platform, returning but new to token, returning same token
  const perToken = db.prepare(`
    WITH w AS (
      SELECT DISTINCT token_symbol, buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now', '-7 days')
      UNION SELECT DISTINCT token_symbol, seller_id FROM _order_flat WHERE created_at >= datetime('now', '-7 days')
    )
    SELECT w.token_symbol AS symbol,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now', '-7 days')
        THEN w.uid END) AS new_platform,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now', '-7 days')
        AND utf.first_token_order_at >= datetime('now', '-7 days')
        THEN w.uid END) AS new_token,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now', '-7 days')
        AND (utf.first_token_order_at IS NULL OR utf.first_token_order_at < datetime('now', '-7 days'))
        THEN w.uid END) AS ret_users
    FROM w
    JOIN _user_first_order ufo ON w.uid = ufo.user_id
    LEFT JOIN token tk ON w.token_symbol = tk.symbol AND tk.deleted_at IS NULL
    LEFT JOIN _user_token_first utf ON w.uid = utf.user_id AND utf.token_id = tk.id
    GROUP BY w.token_symbol
    ORDER BY (new_platform + new_token + ret_users) DESC LIMIT 10
  `).all() as Array<{ symbol: string; new_platform: number; new_token: number; ret_users: number }>;

  const totalNewPlatform = perToken.reduce((s, t) => s + t.new_platform, 0);
  const totalNewToken = perToken.reduce((s, t) => s + t.new_token, 0);
  const totalRet = perToken.reduce((s, t) => s + t.ret_users, 0);
  const totalAll = totalNewPlatform + totalNewToken + totalRet;
  const acqRate = totalAll ? (totalNewPlatform / totalAll * 100) : 0;

  const body = [
    header("User Analysis", `7-day breakdown \u2022 ${today}`, "Users"),
    kpiGrid([
      { label: "New Platform", value: fmtNum(totalNewPlatform), color: "var(--green)" },
      { label: "New Token", value: fmtNum(totalNewToken), color: "var(--orange)" },
      { label: "Returning", value: fmtNum(totalRet), color: "var(--purple)" },
      { label: "Total", value: fmtNum(totalAll), color: "var(--cyan)" },
      { label: "Acq. Rate", value: fmtPct(acqRate), color: acqRate > 20 ? "var(--green)" : "var(--orange)" },
    ]),

    section("gn", "\uD83D\uDC65", "User Breakdown by Token", "7 DAYS",
      chartCanvas("usersChart", 280) +
      dataTable(
        ["Token", "New Platform", "New Token", "Returning", "Total"],
        perToken.map(t => {
          const total = t.new_platform + t.new_token + t.ret_users;
          return [
            `<span class="nm">$${t.symbol}</span>`,
            `<span class="g">${t.new_platform}</span>`,
            `<span class="o">${t.new_token}</span>`,
            `<span class="cy">${t.ret_users}</span>`,
            `${total}`,
          ];
        })
      ) +
      analysisBox([
        `Top token for new platform users: $${perToken[0]?.symbol ?? "N/A"} (${perToken[0]?.new_platform ?? 0} new)`,
        `${totalNewToken} users are existing traders trying new tokens`,
        acqRate > 30 ? `Strong acquisition rate (${fmtPct(acqRate)})` : `Low acquisition \u2014 focus on attracting new traders`,
      ])
    ),
  ].join("\n");

  const charts = `
new Chart(document.getElementById('usersChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(perToken.map(t => '$' + t.symbol))},
    datasets: [
      { label: 'New Platform', data: ${JSON.stringify(perToken.map(t => t.new_platform))}, backgroundColor: '#00ff8888', borderRadius: 4 },
      { label: 'New Token', data: ${JSON.stringify(perToken.map(t => t.new_token))}, backgroundColor: '#ff9d0088', borderRadius: 4 },
      { label: 'Returning', data: ${JSON.stringify(perToken.map(t => t.ret_users))}, backgroundColor: '#a78bfa88', borderRadius: 4 }
    ]
  },
  options: { scales: { x: { stacked: true }, y: { stacked: true } }, plugins: { legend: { position: 'bottom' } } }
});`;

  return htmlPage("User Analysis", body, charts);
}

export function momLayout(db: Database.Database): string {
  const today = new Date().toISOString().slice(0, 10);

  const months = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month,
      ROUND(SUM(order_value_usd_1side) * 2, 0) AS volume,
      COUNT(DISTINCT order_id) AS orders,
      COUNT(DISTINCT buyer_id) + COUNT(DISTINCT seller_id) AS wallets
    FROM _order_flat
    WHERE created_at >= datetime('now', '-6 months')
    GROUP BY month ORDER BY month
  `).all() as Array<{ month: string; volume: number; orders: number; wallets: number }>;

  const cur = months[months.length - 1] ?? { month: "", volume: 0, orders: 0, wallets: 0 };
  const prev = months[months.length - 2] ?? { month: "", volume: 0, orders: 0, wallets: 0 };

  const curNew = db.prepare(`
    WITH w AS (
      SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now','start of month')
      UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= datetime('now','start of month')
    )
    SELECT COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now','start of month') THEN w.uid END) AS n
    FROM w LEFT JOIN _user_first_order ufo ON w.uid = ufo.user_id
  `).get() as { n: number };

  const prevNew = db.prepare(`
    WITH w AS (
      SELECT DISTINCT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now','start of month','-1 month') AND created_at < datetime('now','start of month')
      UNION SELECT DISTINCT seller_id FROM _order_flat WHERE created_at >= datetime('now','start of month','-1 month') AND created_at < datetime('now','start of month')
    )
    SELECT COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now','start of month','-1 month') AND ufo.first_order_at < datetime('now','start of month') THEN w.uid END) AS n
    FROM w LEFT JOIN _user_first_order ufo ON w.uid = ufo.user_id
  `).get() as { n: number };

  const body = [
    header("Month-over-Month", `${cur.month} vs ${prev.month} \u2022 ${today}`, "MoM"),
    kpiGrid([
      { label: "Volume", value: fmtUSD(cur.volume), color: "var(--cyan)", change: pctBadge(cur.volume, prev.volume) },
      { label: "Orders", value: fmtNum(cur.orders), color: "var(--t1)", change: pctBadge(cur.orders, prev.orders) },
      { label: "Wallets", value: fmtNum(cur.wallets), color: "var(--purple)", change: pctBadge(cur.wallets, prev.wallets) },
      { label: "New Users", value: fmtNum(curNew.n), color: "var(--green)", change: pctBadge(curNew.n, prevNew.n) },
    ]),

    section("cy", "\uD83D\uDCCA", "Monthly Volume", `${months.length} MONTHS`,
      chartCanvas("momChart", 240)
    ),

    section("pu", "\uD83D\uDD04", "Metric Comparison", "MOM",
      chartCanvas("compareChart", 200) +
      dataTable(
        ["Metric", cur.month, prev.month, "Change"],
        [
          ["Volume", `<span class="cy">${fmtUSD(cur.volume)}</span>`, fmtUSD(prev.volume), pctBadge(cur.volume, prev.volume)],
          ["Orders", fmtNum(cur.orders), fmtNum(prev.orders), pctBadge(cur.orders, prev.orders)],
          ["Wallets", fmtNum(cur.wallets), fmtNum(prev.wallets), pctBadge(cur.wallets, prev.wallets)],
          ["New Users", `<span class="g">${curNew.n}</span>`, String(prevNew.n), pctBadge(curNew.n, prevNew.n)],
        ]
      )
    ),
  ].join("\n");

  const charts = `
new Chart(document.getElementById('momChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(months.map(m => m.month))},
    datasets: [{ label: 'Volume', data: ${JSON.stringify(months.map(m => m.volume))}, backgroundColor: '#00e5ff88', borderRadius: 4 }]
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } } } }
});
new Chart(document.getElementById('compareChart'), {
  type: 'bar',
  data: {
    labels: ['Volume', 'Orders', 'Wallets', 'New Users'],
    datasets: [
      { label: '${cur.month}', data: [${cur.volume}, ${cur.orders}, ${cur.wallets}, ${curNew.n}], backgroundColor: '#00e5ff88', borderRadius: 4 },
      { label: '${prev.month}', data: [${prev.volume}, ${prev.orders}, ${prev.wallets}, ${prevNew.n}], backgroundColor: '#8b8da355', borderRadius: 4 }
    ]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});`;

  return htmlPage("Month-over-Month", body, charts);
}

// ============================================================
// LAYOUT 4: DIAGNOSTIC
// ============================================================

export function diagnosticLayout(db: Database.Database): string {
  const today = new Date().toISOString().slice(0, 10);

  const daily = db.prepare(`
    SELECT DATE(created_at) AS date,
      ROUND(SUM(order_value_usd_1side) * 2, 0) AS volume,
      COUNT(DISTINCT order_id) AS orders
    FROM _order_flat
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY DATE(created_at) ORDER BY date
  `).all() as Array<{ date: string; volume: number; orders: number }>;

  const recent = daily.slice(-7);
  const prior = daily.slice(0, 7);
  const recentVol = recent.reduce((s, d) => s + d.volume, 0);
  const priorVol = prior.reduce((s, d) => s + d.volume, 0);
  const changePct = priorVol ? ((recentVol - priorVol) / priorVol * 100) : 0;

  const byToken = db.prepare(`
    SELECT token_symbol AS symbol,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN order_value_usd_1side ELSE 0 END)*2, 0) AS cur,
      ROUND(SUM(CASE WHEN created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days') THEN order_value_usd_1side ELSE 0 END)*2, 0) AS prev
    FROM _order_flat
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY token_symbol
    ORDER BY ABS(cur - prev) DESC LIMIT 8
  `).all() as Array<{ symbol: string; cur: number; prev: number }>;

  const userSeg = db.prepare(`
    WITH w AS (
      SELECT buyer_id AS uid FROM _order_flat WHERE created_at >= datetime('now','-7 days')
      UNION ALL SELECT seller_id FROM _order_flat WHERE created_at >= datetime('now','-7 days')
    )
    SELECT
      COUNT(DISTINCT CASE WHEN ufo.first_order_at >= datetime('now','-7 days') THEN w.uid END) AS new_users,
      COUNT(DISTINCT CASE WHEN ufo.first_order_at < datetime('now','-7 days') THEN w.uid END) AS ret_users
    FROM w LEFT JOIN _user_first_order ufo ON w.uid = ufo.user_id
  `).get() as { new_users: number; ret_users: number };

  const body = [
    header("Diagnostic Analysis", `14-day window \u2022 ${today}`, "Diagnostic"),
    kpiGrid([
      { label: "Current (7d)", value: fmtUSD(recentVol), color: "var(--cyan)" },
      { label: "Previous (7d)", value: fmtUSD(priorVol), color: "var(--t2)" },
      { label: "Change", value: `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`, color: changePct >= 0 ? "var(--green)" : "var(--red)" },
    ]),

    section("cy", "\uD83D\uDCC8", "Timeline", "14 DAYS",
      chartCanvas("timelineChart", 240) +
      analysisBox([
        `Volume ${changePct >= 0 ? "increased" : "decreased"} ${Math.abs(changePct).toFixed(1)}% WoW`,
        `Recent 7d avg: ${fmtUSD(recentVol / 7)}/day`,
      ])
    ),

    section("or", "\uD83C\uDFAF", "Drivers by Token", `${byToken.length} tokens`,
      chartCanvas("driversChart", 240) +
      dataTable(
        ["Token", "This Week", "Last Week", "Impact"],
        byToken.map(t => {
          const diff = t.cur - t.prev;
          return [
            `<span class="nm">$${t.symbol}</span>`,
            `<span class="cy">${fmtUSD(t.cur)}</span>`,
            fmtUSD(t.prev),
            `<span class="${diff >= 0 ? 'g' : 'r'}">${diff >= 0 ? '+' : ''}${fmtUSD(diff)}</span>`,
          ];
        })
      )
    ),

    section("pu", "\uD83D\uDC65", "User Segment", "7 DAYS",
      `<div class="pg">
        <div>${chartCanvas("segChart", 180)}</div>
        <div>${dataTable(
          ["Segment", "Count"],
          [
            ["New Users", `<span class="g">${userSeg.new_users}</span>`],
            ["Returning", `<span class="cy">${userSeg.ret_users}</span>`],
          ]
        )}</div>
      </div>`
    ),
  ].join("\n");

  const charts = `
new Chart(document.getElementById('timelineChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(daily.map(d => d.date.slice(5)))},
    datasets: [
      { label: 'Volume', data: ${JSON.stringify(daily.map(d => d.volume))}, borderColor: '#00e5ff', backgroundColor: '#00e5ff22', fill: true, tension: 0.3 },
      { label: 'Orders', data: ${JSON.stringify(daily.map(d => d.orders))}, borderColor: '#f472b6', fill: false, tension: 0.3, yAxisID: 'y1' }
    ]
  },
  options: {
    scales: {
      y: { position: 'left', ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } },
      y1: { position: 'right', grid: { drawOnChartArea: false } }
    }
  }
});
new Chart(document.getElementById('driversChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(byToken.map(t => '$' + t.symbol))},
    datasets: [
      { label: 'This Week', data: ${JSON.stringify(byToken.map(t => t.cur))}, backgroundColor: '#00e5ff88', borderRadius: 4 },
      { label: 'Last Week', data: ${JSON.stringify(byToken.map(t => t.prev))}, backgroundColor: '#8b8da355', borderRadius: 4 }
    ]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});
new Chart(document.getElementById('segChart'), {
  type: 'doughnut',
  data: {
    labels: ['New', 'Returning'],
    datasets: [{ data: [${userSeg.new_users}, ${userSeg.ret_users}], backgroundColor: ['#00ff88', '#a78bfa'], borderWidth: 0 }]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});`;

  return htmlPage("Diagnostic Analysis", body, charts);
}

// ============================================================
// TOPIC ROUTER — maps topic string to layout
// ============================================================

export function buildContextReportHtml(topic: string, db: Database.Database): string {
  // Single token: token-{SYMBOL}
  if (topic.startsWith("token-")) {
    const symbol = topic.replace("token-", "").toUpperCase();
    return singleTokenLayout(db, symbol);
  }

  // Diagnostic
  if (topic.startsWith("diagnostic")) {
    return diagnosticLayout(db);
  }

  // Map topic → layout
  switch (topic) {
    case "top-tokens":
    case "volume":
    case "settle":
    case "settlement":
      return overviewLayout(db);

    case "mom":
      return momLayout(db);

    case "trend":
      return trendLayout(db);

    case "users":
    case "traders":
      return usersLayout(db);

    // Default to overview
    default:
      return overviewLayout(db);
  }
}
