import type { WeeklyAnalysis } from "./weekly-analysis.js";
import { writeFileSync } from "fs";
import { join } from "path";

export function generateWeeklyReportHtml(a: WeeklyAnalysis, outputDir: string): string {
  const fmt = (n: number) => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };
  const pct = (curr: number, prev: number) => {
    if (prev === 0) return curr > 0 ? "+∞%" : "0%";
    return ((curr - prev) / prev * 100).toFixed(1) + "%";
  };
  const pctColor = (curr: number, prev: number) => {
    if (prev === 0) return "text-gray-400";
    return curr >= prev ? "text-green-400" : "text-red-400";
  };

  const unfilledVol = Math.max(a.totalVolumeOnWeb - a.filledVolume, 0);
  const newPct = a.totalUsers > 0 ? (a.newUsers / a.totalUsers * 100) : 0;
  const oldPct = a.totalUsers > 0 ? (a.oldUsers / a.totalUsers * 100) : 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Report | ${a.startDate} - ${a.endDate}</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; background: #0d0c22; }
    .chart-container { position: relative; width: 100%; max-width: 600px; margin: auto; }
  </style>
</head>
<body class="text-white">
<div class="container mx-auto p-4 md:p-8">

  <header class="text-center my-8 md:my-12">
    <h1 class="text-4xl md:text-6xl font-black uppercase tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-[#3b82f6] to-[#ff00ff]">WEEKLY REPORT</h1>
    <p class="text-lg md:text-xl text-gray-300 mt-4">${a.startDate} — ${a.endDate}</p>
  </header>

  <!-- CORE METRICS -->
  <section class="mb-12 md:mb-16">
    <h2 class="text-3xl md:text-5xl font-bold text-center mb-10 text-blue-400 border-b-2 border-blue-400/30 pb-4">Core Metrics</h2>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 text-center mb-12">
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Total Volume on Web</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(a.totalVolumeOnWeb)}</p>
        <p class="text-lg font-semibold ${pctColor(a.totalVolumeOnWeb, a.prevVolumeOnWeb)} mt-2">${pct(a.totalVolumeOnWeb, a.prevVolumeOnWeb)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Filled Volume</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(a.filledVolume)}</p>
        <p class="text-lg font-semibold ${pctColor(a.filledVolume, a.prevFilledVolume)} mt-2">${pct(a.filledVolume, a.prevFilledVolume)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Active Users</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${a.totalUsers}</p>
        <p class="text-lg font-semibold ${pctColor(a.totalUsers, a.prevTotalUsers)} mt-2">${pct(a.totalUsers, a.prevTotalUsers)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Est. Fees</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(a.feesTotal)}</p>
        <p class="text-sm text-gray-400 mt-2">${a.totalOrders} orders</p>
      </div>
    </div>

    <!-- Volume & Users Charts -->
    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700 mb-10">
      <h3 class="text-2xl font-bold text-center mb-6 text-blue-300">Weekly Performance</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
        <div>
          <h4 class="text-lg font-bold text-center mb-4 text-gray-300">Volume Distribution</h4>
          <div class="chart-container h-64">
            <canvas id="volumePieChart"></canvas>
          </div>
          <p class="text-center mt-4 text-gray-300 text-sm">Fill Rate: <strong>${a.fillRate.toFixed(1)}%</strong></p>
        </div>
        <div>
          <h4 class="text-lg font-bold text-center mb-4 text-gray-300">WoW Growth</h4>
          <div class="chart-container h-64">
            <canvas id="growthBarChart"></canvas>
          </div>
        </div>
      </div>
    </div>

    <!-- Users & Token Performance -->
    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700 mb-10">
      <h3 class="text-2xl font-bold text-center mb-8 text-pink-400">Users & Tokens</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
        <div>
          <h4 class="text-lg font-bold text-center mb-2 text-pink-300">User Base (${a.totalUsers})</h4>
          <div class="chart-container h-64">
            <canvas id="userDoughnutChart"></canvas>
          </div>
          <p class="text-center mt-4 text-gray-300 text-sm">
            ${a.newUsers} New (${pct(a.newUsers, a.prevNewUsers)}) · ${a.oldUsers} Old (${pct(a.oldUsers, a.prevOldUsers)})
          </p>
        </div>
        <div>
          <h4 class="text-lg font-bold text-center mb-2 text-pink-300">Top Tokens (Filled Vol)</h4>
          <div class="chart-container h-64">
            <canvas id="tokenBarChart"></canvas>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- DAILY TREND -->
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-green-400 border-b-2 border-green-400/30 pb-4">Daily Trend</h2>
    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700">
      <div style="position: relative; height: 350px; width: 100%;">
        <canvas id="dailyChart"></canvas>
      </div>
    </div>
  </section>

  <!-- TOKEN TABLE -->
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-purple-400 border-b-2 border-purple-400/30 pb-4">Token Breakdown</h2>
    <div class="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-gray-700 overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-800">
          <tr>
            <th class="p-3 text-xs text-gray-300 uppercase">#</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Token</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Filled Vol</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Vol on Web</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Orders</th>
            <th class="p-3 text-xs text-gray-300 uppercase">New / Old</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          ${a.topTokens.map((t, i) => `
          <tr class="hover:bg-gray-800/50">
            <td class="p-3">${i + 1}</td>
            <td class="p-3 font-bold">$${t.symbol}</td>
            <td class="p-3 text-[#3b82f6] font-medium">${fmt(t.filledVolume)}</td>
            <td class="p-3">${fmt(t.volumeOnWeb)}</td>
            <td class="p-3">${t.orders}</td>
            <td class="p-3">${t.newWallets} / ${t.oldWallets}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </section>

</div>

<script>
window.addEventListener('load', () => {
  Chart.register(ChartDataLabels);
  const C = {
    purple: '#a78bfa', magenta: '#f472b6', blue: '#60a5fa',
    red: '#f87171', green: '#4ade80', white: '#FFF',
  };
  Chart.defaults.color = C.white;
  Chart.defaults.plugins.datalabels.color = C.white;
  Chart.defaults.plugins.datalabels.font = { weight: 'bold' };

  // Volume Pie
  new Chart(document.getElementById('volumePieChart'), {
    type: 'doughnut',
    data: {
      labels: ['Filled', 'Unfilled'],
      datasets: [{ data: [${a.filledVolume}, ${unfilledVol}], backgroundColor: [C.blue, 'rgba(255,255,255,0.1)'], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { datalabels: { formatter: (v, ctx) => (v * 100 / ${a.totalVolumeOnWeb || 1}).toFixed(1) + '%' } }
    }
  });

  // Growth Bar
  const growthData = [
    ${a.prevVolumeOnWeb > 0 ? ((a.totalVolumeOnWeb - a.prevVolumeOnWeb) / a.prevVolumeOnWeb * 100).toFixed(1) : 0},
    ${a.prevFilledVolume > 0 ? ((a.filledVolume - a.prevFilledVolume) / a.prevFilledVolume * 100).toFixed(1) : 0},
    ${a.prevTotalUsers > 0 ? ((a.totalUsers - a.prevTotalUsers) / a.prevTotalUsers * 100).toFixed(1) : 0},
    ${a.prevNewUsers > 0 ? ((a.newUsers - a.prevNewUsers) / a.prevNewUsers * 100).toFixed(1) : 0},
    ${a.prevOldUsers > 0 ? ((a.oldUsers - a.prevOldUsers) / a.prevOldUsers * 100).toFixed(1) : 0},
  ];
  new Chart(document.getElementById('growthBarChart'), {
    type: 'bar',
    data: {
      labels: ['Web Vol', 'Filled Vol', 'Users', 'New', 'Old'],
      datasets: [{ data: growthData, backgroundColor: growthData.map(v => v < 0 ? C.red : C.green) }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, datalabels: { formatter: v => v.toFixed(1) + '%', anchor: 'center' } }
    }
  });

  // User Doughnut
  new Chart(document.getElementById('userDoughnutChart'), {
    type: 'doughnut',
    data: {
      labels: ['New', 'Old'],
      datasets: [{ data: [${a.newUsers}, ${a.oldUsers}], backgroundColor: [C.blue, C.magenta], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { datalabels: { formatter: v => v } }
    }
  });

  // Token Bar
  new Chart(document.getElementById('tokenBarChart'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(a.topTokens.slice(0, 8).map(t => t.symbol))},
      datasets: [{ data: ${JSON.stringify(a.topTokens.slice(0, 8).map(t => t.filledVolume))}, backgroundColor: C.blue }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          formatter: v => v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(1) + 'K' : '$' + v,
          anchor: 'end', align: 'top', font: { size: 10 }
        }
      }
    }
  });

  // Daily Chart
  new Chart(document.getElementById('dailyChart'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(a.dailyVolume.map(d => d.day))},
      datasets: [{
        label: 'Volume',
        data: ${JSON.stringify(a.dailyVolume.map(d => d.volume))},
        backgroundColor: '#3b82f6', borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          formatter: v => v >= 1e3 ? '$' + (v/1e3).toFixed(1) + 'K' : '$' + v,
          anchor: 'end', align: 'top', font: { size: 10 }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: v => '$' + (v/1e3).toFixed(0) + 'K' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
});
<\/script>
</body>
</html>`;

  const filename = `weekly-report-${a.startDate}.html`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, html);
  return filepath;
}
