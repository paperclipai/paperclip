import type { TokenAnalysis } from "./token-analysis.js";
import { writeFileSync } from "fs";
import { join } from "path";

export function generateTokenReportHtml(a: TokenAnalysis, outputDir: string): string {
  const dateStr = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "short", year: "numeric" });
  const askBidTotal = a.askVolume + a.bidVolume;
  const fillRate = askBidTotal > 0 ? (a.totalValueUsd / askBidTotal * 100) : 0;
  const askPct = askBidTotal > 0 ? (a.askVolume / askBidTotal * 100) : 50;
  const bidPct = 100 - askPct;
  const totalUsers = a.newUsers + a.oldUsers;
  const newPct = totalUsers > 0 ? (a.newUsers / totalUsers * 100) : 0;

  const fmt = (n: number) => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };

  // Classify top wallets
  const sellers = a.topWallets.filter(w => w.role === "Seller");
  const buyers = a.topWallets.filter(w => w.role === "Buyer");

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>$${a.symbol} Token Report</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: { extend: { colors: {
        bgMain:'#0B0E11', surface:'#141920', elevated:'#1C2530',
        brand:'#00E67A', success:'#00D26A', danger:'#FF4D5A', warning:'#FFB800', info:'#3B82F6',
        textPrimary:'#FFFFFF', textSecondary:'#A0AEC0', textTertiary:'#4A5568', borderMain:'#2D3748'
      }}}
    }
  <\/script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
    body { font-family: 'Inter', sans-serif; }
  </style>
</head>
<body class="p-4 md:p-8 bg-bgMain text-textPrimary">
<div class="max-w-7xl mx-auto space-y-6">

  <!-- HEADER -->
  <header class="bg-surface border border-borderMain p-6 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
    <div>
      <div class="flex items-center gap-3 mb-1">
        <i class="fa-solid fa-chart-pie text-brand text-2xl"></i>
        <h1 class="text-3xl font-bold uppercase tracking-wider">TOKEN REPORT: <span class="text-brand">$${a.symbol}</span></h1>
      </div>
      <p class="text-textSecondary text-sm font-mono">${dateStr} · On-chain analysis & trader behavior</p>
    </div>
    <div class="flex items-center gap-3 bg-elevated px-4 py-2 rounded-lg border border-borderMain">
      <i class="fa-solid fa-database text-info"></i>
      <div>
        <p class="text-xs text-textSecondary font-bold uppercase tracking-wider">Status</p>
        <p class="text-sm font-bold">${a.settleRate > 0 ? "Post-TGE" : "Pre-TGE"}</p>
      </div>
    </div>
  </header>

  <!-- KPI CARDS -->
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    <div class="bg-surface border border-borderMain p-5 rounded-xl border-t-2 border-t-brand hover:bg-elevated transition-colors">
      <p class="text-textSecondary text-sm font-semibold mb-1">Total Volume</p>
      <h3 class="text-3xl font-bold">${fmt(a.totalValueUsd)}</h3>
      <p class="text-textTertiary text-xs mt-2">${a.totalOrders.toLocaleString()} orders</p>
    </div>
    <div class="bg-surface border border-borderMain p-5 rounded-xl border-t-2 border-t-${a.settleRate >= 80 ? 'success' : a.settleRate > 0 ? 'warning' : 'textSecondary'} hover:bg-elevated transition-colors">
      <p class="text-textSecondary text-sm font-semibold mb-1">Settle Rate</p>
      <h3 class="text-3xl font-bold">${a.settleRate > 0 ? a.settleRate + "%" : "Pre-TGE"}</h3>
      <p class="text-textTertiary text-xs mt-2">${a.settledOrders} settled · ${a.cancelledOrders} cancelled</p>
    </div>
    <div class="bg-surface border border-borderMain p-5 rounded-xl border-t-2 border-t-${a.top5WhalePct > 60 ? 'danger' : a.top5WhalePct > 40 ? 'warning' : 'success'} hover:bg-elevated transition-colors">
      <p class="text-textSecondary text-sm font-semibold mb-1">Whale Concentration</p>
      <h3 class="text-3xl font-bold">${a.top5WhalePct}%</h3>
      <p class="text-textTertiary text-xs mt-2">Top 5 wallets volume share</p>
    </div>
    <div class="bg-surface border border-borderMain p-5 rounded-xl border-t-2 border-t-info hover:bg-elevated transition-colors">
      <p class="text-textSecondary text-sm font-semibold mb-1">New Users</p>
      <h3 class="text-3xl font-bold">${newPct.toFixed(0)}%</h3>
      <p class="text-textTertiary text-xs mt-2">${a.newUsers} new · ${a.oldUsers} returning</p>
    </div>
  </div>

  <!-- CHARTS ROW -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Order Size Distribution -->
    <div class="bg-surface border border-borderMain rounded-xl p-6 flex flex-col items-center hover:bg-elevated transition-colors">
      <h3 class="text-lg font-bold mb-4 w-full text-left">Order Size Distribution</h3>
      <div class="relative w-full max-w-[250px] aspect-square"><canvas id="orderSizeChart"></canvas></div>
      <p class="text-sm text-textSecondary mt-4 text-center">${a.orderBuckets.length > 0 ? `${a.orderBuckets[a.orderBuckets.length - 1]?.bucket || ""} orders dominate volume` : ""}</p>
    </div>

    <!-- User Demographics -->
    <div class="bg-surface border border-borderMain rounded-xl p-6 flex flex-col items-center hover:bg-elevated transition-colors">
      <h3 class="text-lg font-bold mb-4 w-full text-left">User Demographics</h3>
      <div class="relative w-full max-w-[250px] aspect-square"><canvas id="userChart"></canvas></div>
      <p class="text-sm text-textSecondary mt-4 text-center">${newPct > 70 ? "Strong acquisition — mostly new users" : newPct < 30 ? "Insider-driven — mostly returning users" : "Balanced user mix"}</p>
    </div>

    <!-- Ask/Bid Balance -->
    <div class="bg-surface border border-borderMain rounded-xl p-6 hover:bg-elevated transition-colors">
      <h3 class="text-lg font-bold mb-4">Orderbook Balance</h3>
      <div class="space-y-4">
        <div class="bg-bgMain p-3 rounded border border-borderMain">
          <div class="flex justify-between items-center mb-1">
            <span class="text-danger font-bold text-sm">Ask (Sell)</span>
            <span class="font-mono text-sm">${fmt(a.askVolume)} · ${askPct.toFixed(0)}%</span>
          </div>
          <div class="w-full bg-borderMain rounded-full h-2"><div class="bg-danger h-2 rounded-full" style="width:${askPct}%"></div></div>
        </div>
        <div class="bg-bgMain p-3 rounded border border-borderMain">
          <div class="flex justify-between items-center mb-1">
            <span class="text-success font-bold text-sm">Bid (Buy)</span>
            <span class="font-mono text-sm">${fmt(a.bidVolume)} · ${bidPct.toFixed(0)}%</span>
          </div>
          <div class="w-full bg-borderMain rounded-full h-2"><div class="bg-success h-2 rounded-full" style="width:${bidPct}%"></div></div>
        </div>
        <div class="bg-bgMain p-3 rounded border border-borderMain">
          <div class="flex justify-between items-center mb-1">
            <span class="text-brand font-bold text-sm">Fill Rate</span>
            <span class="font-mono text-sm">${fillRate.toFixed(1)}%</span>
          </div>
          <div class="w-full bg-borderMain rounded-full h-2"><div class="bg-brand h-2 rounded-full" style="width:${Math.min(fillRate, 100)}%"></div></div>
        </div>
      </div>
      <p class="text-sm text-textSecondary mt-4">${bidPct > 60 ? "Buy demand dominant" : bidPct < 30 ? "Heavy sell pressure" : "Balanced orderbook"}</p>
    </div>
  </div>

  <!-- VOLUME TIMELINE -->
  <div class="bg-surface border border-borderMain rounded-xl p-6">
    <div class="flex items-center gap-2 mb-4">
      <i class="fa-regular fa-calendar text-textSecondary"></i>
      <h3 class="text-lg font-bold">Weekly Volume Trend</h3>
    </div>
    <div class="relative h-48 w-full"><canvas id="trendChart"></canvas></div>
    ${a.peakDays.length > 0 ? `
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
      ${a.peakDays.slice(0, 5).map(p => `
      <div class="bg-bgMain p-3 rounded border border-borderMain text-center">
        <div class="text-xs text-textTertiary mb-1">${p.day}</div>
        <div class="font-bold ${p.pctOfTotal > 10 ? 'text-brand' : 'text-textPrimary'}">${fmt(p.volume)}</div>
        <div class="text-xs text-textTertiary">${p.pctOfTotal}% of total</div>
      </div>`).join("")}
    </div>` : ""}
  </div>

  <!-- TOP WALLETS TABLE -->
  <div class="bg-surface border border-borderMain rounded-xl p-6">
    <div class="flex items-center gap-2 mb-4">
      <i class="fa-solid fa-list-ol text-textSecondary"></i>
      <h3 class="text-lg font-bold">Top Wallets</h3>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b border-borderMain text-textTertiary text-sm uppercase">
            <th class="p-3">#</th>
            <th class="p-3">Address</th>
            <th class="p-3 text-right">Volume</th>
            <th class="p-3 text-right">Orders</th>
            <th class="p-3 text-right">Role</th>
          </tr>
        </thead>
        <tbody class="font-mono text-sm">
          ${a.topWallets.map((w, i) => `
          <tr class="border-b border-borderMain hover:bg-elevated transition-colors">
            <td class="p-3 text-textTertiary">${i + 1}</td>
            <td class="p-3">${w.address}</td>
            <td class="p-3 text-right font-bold">${fmt(w.volume)}</td>
            <td class="p-3 text-right text-textSecondary">${w.orders}</td>
            <td class="p-3 text-right"><span class="px-2 py-1 rounded text-xs border ${w.role === "Buyer" ? "bg-success/10 text-success border-success/20" : "bg-danger/10 text-danger border-danger/20"}">${w.role.toUpperCase()}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>

  <!-- SUMMARY -->
  <div class="bg-surface border border-borderMain border-l-4 border-l-brand p-6 rounded-r-xl rounded-l-sm">
    <h2 class="text-xl font-bold mb-2 uppercase flex items-center gap-2">Summary</h2>
    <p class="text-textSecondary leading-relaxed text-sm">
      $${a.symbol}: ${fmt(a.totalValueUsd)} total volume across ${a.totalOrders.toLocaleString()} orders from ${totalUsers} wallets.
      ${a.settleRate > 0 ? `Settlement rate ${a.settleRate}% (${a.settleRate >= 80 ? "healthy" : "below benchmark"}).` : "Pre-TGE — no settlement data yet."}
      Top 5 wallets control ${a.top5WhalePct}% of volume.
      ${newPct > 70 ? `Strong acquisition: ${newPct.toFixed(0)}% new users.` : `${newPct.toFixed(0)}% new users.`}
      ${bidPct < 30 ? "Significant sell pressure in orderbook." : bidPct > 60 ? "Strong buy demand." : "Balanced orderbook."}
      Estimated platform fees: ${fmt(a.feesTotal)}.
    </p>
  </div>

</div>

<script>
Chart.defaults.color = '#A0AEC0';
Chart.defaults.font.family = 'Inter';
const C = { brand:'#00E67A', success:'#00D26A', danger:'#FF4D5A', warning:'#FFB800', info:'#3B82F6', gray:'#4A5568', dark:'#2D3748' };

// Order Size
new Chart(document.getElementById('orderSizeChart'), {
  type: 'doughnut',
  data: {
    labels: ${JSON.stringify(a.orderBuckets.map(b => b.bucket))},
    datasets: [{ data: ${JSON.stringify(a.orderBuckets.map(b => b.totalUsd))}, backgroundColor: [C.brand, C.info, C.warning, C.gray, C.danger, '#A855F7', '#EC4899'], borderWidth: 0 }]
  },
  options: { responsive:true, maintainAspectRatio:false, cutout:'75%', plugins: { legend: { position:'bottom', labels: { padding:15, usePointStyle:true } } } }
});

// Users
new Chart(document.getElementById('userChart'), {
  type: 'doughnut',
  data: {
    labels: ['New Users', 'Returning'],
    datasets: [{ data: [${a.newUsers}, ${a.oldUsers}], backgroundColor: [C.warning, C.dark], borderWidth: 0 }]
  },
  options: { responsive:true, maintainAspectRatio:false, cutout:'75%', plugins: { legend: { position:'bottom', labels: { padding:15, usePointStyle:true } } } }
});

// Weekly Trend
new Chart(document.getElementById('trendChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(a.weeklyTrend.map(w => w.week))},
    datasets: [{ label: 'Volume', data: ${JSON.stringify(a.weeklyTrend.map(w => w.volume))},
      backgroundColor: (ctx) => ctx.dataset.data[ctx.dataIndex] > ${Math.max(...a.weeklyTrend.map(w => w.volume)) * 0.7} ? C.brand : C.gray,
      borderRadius: 4
    }]
  },
  options: { responsive:true, maintainAspectRatio:false, plugins: { legend:{display:false} },
    scales: { y:{grid:{color:C.dark},border:{display:false}}, x:{grid:{display:false},border:{display:false}} }
  }
});
<\/script>
</body>
</html>`;

  const filename = `${a.symbol.toLowerCase()}-report-${new Date().toISOString().slice(0, 10)}.html`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, html);
  return filepath;
}
