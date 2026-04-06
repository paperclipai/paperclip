// report-html.ts
// Generate dark-theme HTML dashboard report with Chart.js
// Render to PNG via Puppeteer

import puppeteer from "puppeteer";

export interface ReportData {
  title: string;
  timeframe: string;
  // Core metrics
  totalOrders: number;
  filledVolume: number;
  filledVolumePrev: number;
  exitVolume: number;
  totalFees: number;
  activeWallets: number;
  newUsers: number;
  returningUsers: number;
  // Top tokens
  topTokens: Array<{ symbol: string; volume: number; orders: number; chain: string }>;
  // Daily trend
  dailyTrend: Array<{ date: string; volume: number; orders: number }>;
  // GA4
  gaActiveUsers?: number;
  gaActiveUsersPrev?: number;
  gaSessions?: number;
  gaSessionsPrev?: number;
  trafficSources?: Array<{ source: string; sessions: number }>;
  topLandingPages?: Array<{ page: string; sessions: number }>;
  // Settle
  settledOrders?: number;
  cancelledOrders?: number;
  settleRate?: number;
  settleByToken?: Array<{ symbol: string; settled: number; cancelled: number; total: number; rate: number }>;
}

function pctChange(cur: number, prev: number): string {
  if (!prev) return "";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  const color = pct >= 0 ? "#4ade80" : "#f87171";
  return `<span style="color:${color};font-size:12px">${sign}${pct.toFixed(1)}%</span>`;
}

function fmtUSD(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function buildReportHtml(data: ReportData): string {
  const topTokenLabels = JSON.stringify(data.topTokens.map(t => `$${t.symbol}`));
  const topTokenValues = JSON.stringify(data.topTokens.map(t => Math.round(t.volume)));
  const topTokenOrders = JSON.stringify(data.topTokens.map(t => t.orders));

  const trendLabels = JSON.stringify(data.dailyTrend.map(d => d.date.slice(5)));
  const trendVolumes = JSON.stringify(data.dailyTrend.map(d => Math.round(d.volume)));
  const trendOrders = JSON.stringify(data.dailyTrend.map(d => d.orders));

  const trafficLabels = JSON.stringify((data.trafficSources ?? []).map(s => s.source));
  const trafficValues = JSON.stringify((data.trafficSources ?? []).map(s => s.sessions));

  const totalWallets = data.newUsers + data.returningUsers;
  const acqRate = totalWallets > 0 ? (data.newUsers / totalWallets * 100).toFixed(1) : "0";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117; color: #e2e8f0;
    width: 800px; padding: 24px;
  }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { font-size: 22px; color: #38bdf8; margin-bottom: 4px; }
  .header .timeframe { font-size: 13px; color: #94a3b8; }

  .metrics-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px;
  }
  .metric-card {
    background: #1e2030; border-radius: 10px; padding: 14px; text-align: center;
    border: 1px solid #2d3148;
  }
  .metric-card .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  .metric-card .value { font-size: 22px; font-weight: 700; color: #f1f5f9; margin: 6px 0 2px; }
  .metric-card .change { font-size: 12px; }

  .section { margin-bottom: 20px; }
  .section-title {
    font-size: 14px; font-weight: 600; color: #94a3b8;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #2d3148;
  }

  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .chart-box { background: #1e2030; border-radius: 10px; padding: 16px; border: 1px solid #2d3148; }
  .chart-full { background: #1e2030; border-radius: 10px; padding: 16px; border: 1px solid #2d3148; margin-bottom: 20px; }

  .landing-list { background: #1e2030; border-radius: 10px; padding: 14px; border: 1px solid #2d3148; }
  .landing-item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #2d3148; }
  .landing-item:last-child { border-bottom: none; }
  .landing-item .page { color: #38bdf8; font-size: 13px; }
  .landing-item .count { color: #4ade80; font-weight: 600; font-size: 13px; }

  canvas { max-width: 100%; }
</style>
</head>
<body>

<div class="header">
  <h1>🐳 ${data.title}</h1>
  <div class="timeframe">${data.timeframe}</div>
</div>

<!-- Core Metrics -->
<div class="metrics-grid">
  <div class="metric-card">
    <div class="label">Filled Volume</div>
    <div class="value">${fmtUSD(data.filledVolume)}</div>
    <div class="change">${pctChange(data.filledVolume, data.filledVolumePrev)}</div>
  </div>
  <div class="metric-card">
    <div class="label">Orders</div>
    <div class="value">${data.totalOrders}</div>
  </div>
  <div class="metric-card">
    <div class="label">Fees</div>
    <div class="value">${fmtUSD(data.totalFees)}</div>
  </div>
  <div class="metric-card">
    <div class="label">Active Wallets</div>
    <div class="value">${data.activeWallets}</div>
    <div class="change">New: ${data.newUsers} (${acqRate}%)</div>
  </div>
</div>

<!-- Volume Trend -->
<div class="section">
  <div class="section-title">📈 Daily Volume & Orders Trend</div>
  <div class="chart-full">
    <canvas id="trendChart" height="200"></canvas>
  </div>
</div>

<!-- Top Tokens + Users -->
<div class="chart-row">
  <div class="chart-box">
    <div class="section-title" style="border:none;margin-bottom:8px">🏅 Top Tokens by Volume</div>
    <canvas id="tokenChart" height="220"></canvas>
  </div>
  <div class="chart-box">
    <div class="section-title" style="border:none;margin-bottom:8px">👥 Users Breakdown</div>
    <canvas id="userChart" height="220"></canvas>
  </div>
</div>

<!-- Traffic -->
${data.trafficSources && data.trafficSources.length > 0 ? `
<div class="section">
  <div class="section-title">🌐 Website Traffic</div>
  <div class="chart-row">
    <div class="chart-box">
      <div class="metrics-grid" style="grid-template-columns: 1fr 1fr; margin-bottom:12px">
        <div class="metric-card" style="padding:10px">
          <div class="label">Active Users</div>
          <div class="value" style="font-size:18px">${data.gaActiveUsers?.toLocaleString() ?? '-'}</div>
          <div class="change">${pctChange(data.gaActiveUsers ?? 0, data.gaActiveUsersPrev ?? 0)}</div>
        </div>
        <div class="metric-card" style="padding:10px">
          <div class="label">Sessions</div>
          <div class="value" style="font-size:18px">${data.gaSessions?.toLocaleString() ?? '-'}</div>
          <div class="change">${pctChange(data.gaSessions ?? 0, data.gaSessionsPrev ?? 0)}</div>
        </div>
      </div>
      <canvas id="trafficChart" height="160"></canvas>
    </div>
    <div class="chart-box">
      <div class="section-title" style="border:none;margin-bottom:8px">🚪 Top Pre-Market Pages</div>
      <div class="landing-list">
        ${(data.topLandingPages ?? []).slice(0, 5).map(p => {
          const token = p.page.replace("/en/premarket/", "$");
          return `<div class="landing-item"><span class="page">${token}</span><span class="count">${p.sessions} sessions</span></div>`;
        }).join("")}
      </div>
    </div>
  </div>
</div>
` : ''}

<!-- Settlement -->
<div class="section">
  <div class="section-title">⚖️ Settlement Performance</div>
  ${(data.settleByToken ?? []).length === 0
    ? `<div class="metric-card" style="text-align:center;padding:20px"><div class="value" style="color:#94a3b8;font-size:16px">Không có token nào được settle trong kỳ này</div></div>`
    : `<div class="landing-list">
      <div class="landing-item" style="font-weight:600;color:#94a3b8;font-size:11px;text-transform:uppercase">
        <span style="flex:1">Token</span>
        <span style="width:60px;text-align:center">Settled</span>
        <span style="width:60px;text-align:center">Cancel</span>
        <span style="width:70px;text-align:right">Rate</span>
      </div>
      ${(data.settleByToken ?? []).map(t => {
        const rateColor = t.rate >= 80 ? '#4ade80' : t.rate >= 50 ? '#fbbf24' : '#f87171';
        return `<div class="landing-item">
          <span class="page" style="flex:1">$${t.symbol}</span>
          <span style="width:60px;text-align:center;color:#4ade80">${t.settled}</span>
          <span style="width:60px;text-align:center;color:#f87171">${t.cancelled}</span>
          <span style="width:70px;text-align:right;font-weight:700;color:${rateColor}">${t.rate.toFixed(1)}%</span>
        </div>`;
      }).join("")}
    </div>`
  }
</div>

<script>
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = '#2d3148';

// Trend chart
new Chart(document.getElementById('trendChart'), {
  type: 'line',
  data: {
    labels: ${trendLabels},
    datasets: [
      { label: 'Volume (USD)', data: ${trendVolumes}, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', fill: true, tension: 0.3, yAxisID: 'y' },
      { label: 'Orders', data: ${trendOrders}, borderColor: '#f472b6', backgroundColor: 'rgba(244,114,182,0.1)', fill: false, tension: 0.3, yAxisID: 'y1' }
    ]
  },
  options: {
    responsive: true,
    scales: {
      y: { position: 'left', ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } },
      y1: { position: 'right', grid: { drawOnChartArea: false } }
    }
  }
});

// Token chart
new Chart(document.getElementById('tokenChart'), {
  type: 'bar',
  data: {
    labels: ${topTokenLabels},
    datasets: [{ label: 'Volume', data: ${topTokenValues}, backgroundColor: '#38bdf8', borderRadius: 4 }]
  },
  options: {
    indexAxis: 'y',
    scales: { x: { ticks: { callback: v => '$'+(v/1000).toFixed(0)+'K' } } }
  }
});

// User chart
new Chart(document.getElementById('userChart'), {
  type: 'doughnut',
  data: {
    labels: ['New Users', 'Returning'],
    datasets: [{ data: [${data.newUsers}, ${data.returningUsers}], backgroundColor: ['#4ade80', '#a78bfa'], borderWidth: 0 }]
  },
  options: { plugins: { legend: { position: 'bottom' } } }
});

// Traffic chart
${data.trafficSources && data.trafficSources.length > 0 ? `
new Chart(document.getElementById('trafficChart'), {
  type: 'doughnut',
  data: {
    labels: ${trafficLabels},
    datasets: [{ data: ${trafficValues}, backgroundColor: ['#38bdf8','#fbbf24','#4ade80','#a78bfa','#f472b6'], borderWidth: 0 }]
  },
  options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
});` : ''}
</script>
</body>
</html>`;
}

// ============================================================
// RENDER TO PNG
// ============================================================

export async function renderReportToPng(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200 });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Wait for charts to render
    await new Promise(r => setTimeout(r, 1000));

    // Get full page height
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewport({ width: 800, height: bodyHeight + 48 });

    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    return Buffer.from(screenshot);
  } finally {
    await browser.close();
  }
}
