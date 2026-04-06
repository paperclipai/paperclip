import type { ReportData } from "./report-builder.js";
import { writeFileSync } from "fs";
import { join } from "path";

export function generatePeriodReportHtml(d: ReportData, outputDir: string): string {
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

  const unfilledVol = Math.max(d.volumeOnWeb - d.filledVolume, 0);
  const fillRate = d.volumeOnWeb > 0 ? (d.filledVolume / d.volumeOnWeb * 100) : 0;
  const title = d.label.charAt(0) + d.label.slice(1).toLowerCase();

  // For monthly: aggregate daily into weekly
  let activityLabels: string[];
  let activityData: number[];
  if (d.period === "monthly" && d.dailyBreakdown.length > 7) {
    const weeks = new Map<string, number>();
    d.dailyBreakdown.forEach(x => {
      const dt = new Date(x.day + "T12:00:00");
      const ws = new Date(dt);
      ws.setDate(dt.getDate() - dt.getDay() + 1);
      const key = "W" + ws.toISOString().slice(5, 10);
      weeks.set(key, (weeks.get(key) || 0) + x.volume);
    });
    const sorted = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    activityLabels = sorted.map(([k]) => k);
    activityData = sorted.map(([, v]) => v);
  } else {
    activityLabels = d.dailyBreakdown.map(x => x.day);
    activityData = d.dailyBreakdown.map(x => x.volume);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} Report | ${d.dateRange}</title>
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
    <h1 class="text-4xl md:text-6xl font-black uppercase tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-[#3b82f6] to-[#ff00ff]">${d.label} REPORT</h1>
    <p class="text-lg md:text-xl text-gray-300 mt-4">${d.dateRange}</p>
  </header>

  <!-- CORE METRICS -->
  <section class="mb-12 md:mb-16">
    <h2 class="text-3xl md:text-5xl font-bold text-center mb-10 text-blue-400 border-b-2 border-blue-400/30 pb-4">Core Metrics</h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 text-center mb-12">
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Volume on Web</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(d.volumeOnWeb)}</p>
        <p class="text-lg font-semibold ${pctColor(d.volumeOnWeb, d.prevVolumeOnWeb)} mt-2">${pct(d.volumeOnWeb, d.prevVolumeOnWeb)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Filled Volume</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(d.filledVolume)}</p>
        <p class="text-lg font-semibold ${pctColor(d.filledVolume, d.prevFilledVolume)} mt-2">${pct(d.filledVolume, d.prevFilledVolume)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Active Users</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${d.totalUsers}</p>
        <p class="text-lg font-semibold ${pctColor(d.totalUsers, d.prevTotalUsers)} mt-2">${pct(d.totalUsers, d.prevTotalUsers)}</p>
      </div>
      <div class="bg-gray-800/50 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Est. Fees</h3>
        <p class="text-4xl font-bold text-[#3b82f6]">${fmt(d.feesTotal)}</p>
        <p class="text-sm text-gray-400 mt-2">${d.totalOrders} orders</p>
      </div>
    </div>

    <!-- Charts -->
    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700 mb-10">
      <h3 class="text-2xl font-bold text-center mb-6 text-blue-300">Performance</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
        <div>
          <h4 class="text-lg font-bold text-center mb-4 text-gray-300">Volume Distribution</h4>
          <div class="chart-container h-64"><canvas id="volumePieChart"></canvas></div>
          <p class="text-center mt-4 text-gray-300 text-sm">Fill Rate: <strong>${fillRate.toFixed(1)}%</strong></p>
        </div>
        <div>
          <h4 class="text-lg font-bold text-center mb-4 text-gray-300">Growth vs Previous</h4>
          <div class="chart-container h-64"><canvas id="growthBarChart"></canvas></div>
        </div>
      </div>
    </div>

    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700 mb-10">
      <h3 class="text-2xl font-bold text-center mb-8 text-pink-400">Users & Tokens</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
        <div>
          <h4 class="text-lg font-bold text-center mb-2 text-pink-300">User Base (${d.totalUsers})</h4>
          <div class="chart-container h-64"><canvas id="userDoughnutChart"></canvas></div>
          <p class="text-center mt-4 text-gray-300 text-sm">${d.newUsers} New · ${d.oldUsers} Old</p>
        </div>
        <div>
          <h4 class="text-lg font-bold text-center mb-2 text-pink-300">Top Tokens (Filled Vol)</h4>
          <div class="chart-container h-64"><canvas id="tokenBarChart"></canvas></div>
        </div>
      </div>
    </div>
  </section>

  <!-- ACTIVITY TREND -->
  ${activityData.length > 1 ? `
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-green-400 border-b-2 border-green-400/30 pb-4">${d.period === "monthly" ? "Weekly" : "Daily"} Trend</h2>
    <div class="bg-white/10 backdrop-blur-sm p-6 md:p-8 rounded-2xl border border-gray-700">
      <div style="position: relative; height: 350px; width: 100%;"><canvas id="activityChart"></canvas></div>
    </div>
  </section>` : ""}

  <!-- TOKEN TABLE -->
  ${d.topTokens.length > 0 ? `
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-purple-400 border-b-2 border-purple-400/30 pb-4">Token Breakdown</h2>
    <div class="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-gray-700 overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-800">
          <tr>
            <th class="p-3 text-xs text-gray-300 uppercase">#</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Token</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Filled Vol</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Orders</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Wallets</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          ${d.topTokens.map((t, i) => `
          <tr class="hover:bg-gray-800/50">
            <td class="p-3">${i + 1}</td>
            <td class="p-3 font-bold">$${t.symbol}</td>
            <td class="p-3 text-[#3b82f6] font-medium">${fmt(t.volume)}</td>
            <td class="p-3">${t.orders}</td>
            <td class="p-3">${t.wallets}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </section>` : ""}

  <!-- SOCIAL -->
  ${d.socialData ? `
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-pink-400 border-b-2 border-pink-400/30 pb-4">Social Performance</h2>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-center mb-8">
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${d.socialData.totalPosts}</p>
        <p class="text-xs text-gray-400 uppercase">Posts</p>
      </div>
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${fmt(d.socialData.totalViews)}</p>
        <p class="text-xs text-gray-400 uppercase">Views</p>
      </div>
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${d.socialData.totalLikes.toLocaleString()}</p>
        <p class="text-xs text-gray-400 uppercase">Likes</p>
      </div>
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${d.socialData.totalRT.toLocaleString()}</p>
        <p class="text-xs text-gray-400 uppercase">Retweets</p>
      </div>
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${d.socialData.totalBookmarks.toLocaleString()}</p>
        <p class="text-xs text-gray-400 uppercase">Bookmarks</p>
      </div>
      <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700">
        <p class="text-2xl font-bold text-pink-400">${d.socialData.engRate.toFixed(2)}%</p>
        <p class="text-xs text-gray-400 uppercase">Eng. Rate</p>
      </div>
    </div>
    ${d.socialData.topPosts.length > 0 ? `
    <div class="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-gray-700 mb-8">
      <h3 class="text-xl font-bold text-center mb-4 text-pink-300">Top Posts by Engagement</h3>
      <div class="chart-container" style="height: 300px;"><canvas id="socialChart"></canvas></div>
    </div>
    <div class="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-gray-700 overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-800">
          <tr>
            <th class="p-3 text-xs text-gray-300 uppercase">Date</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Post</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Views</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Likes</th>
            <th class="p-3 text-xs text-gray-300 uppercase">RT</th>
            <th class="p-3 text-xs text-gray-300 uppercase">Saves</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          ${d.socialData.topPosts.map(p => `
          <tr class="hover:bg-gray-800/50">
            <td class="p-3 text-xs">${p.date.slice(5)}</td>
            <td class="p-3"><a href="${p.link}" class="text-pink-300 hover:underline">${p.content.slice(0, 45)}${p.content.length > 45 ? "..." : ""}</a></td>
            <td class="p-3 font-medium">${fmt(p.views)}</td>
            <td class="p-3">${p.likes}</td>
            <td class="p-3">${p.retweets}</td>
            <td class="p-3">${p.bookmarks}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
  </section>` : ""}

  <!-- WEBSITE / GA4 -->
  ${d.ga4 ? `
  <section class="mb-12">
    <h2 class="text-3xl font-bold text-center mb-10 text-green-400 border-b-2 border-green-400/30 pb-4">Website Traffic</h2>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center mb-8">
      <div class="bg-gray-800/50 p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Active Users</h3>
        <p class="text-4xl font-bold text-green-400">${d.ga4.activeUsers.toLocaleString()}</p>
        <p class="text-lg font-semibold ${d.ga4.activeUsersPct >= 0 ? "text-green-400" : "text-red-400"} mt-2">${d.ga4.activeUsersPct >= 0 ? "+" : ""}${d.ga4.activeUsersPct.toFixed(1)}%</p>
      </div>
      <div class="bg-gray-800/50 p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">New Users</h3>
        <p class="text-4xl font-bold text-green-400">${d.ga4.newUsers.toLocaleString()}</p>
        <p class="text-lg font-semibold ${d.ga4.newUsersPct >= 0 ? "text-green-400" : "text-red-400"} mt-2">${d.ga4.newUsersPct >= 0 ? "+" : ""}${d.ga4.newUsersPct.toFixed(1)}%</p>
      </div>
      <div class="bg-gray-800/50 p-6 rounded-2xl border border-gray-700">
        <h3 class="text-sm text-gray-400 uppercase mb-2">Sessions</h3>
        <p class="text-4xl font-bold text-green-400">${d.ga4.sessions.toLocaleString()}</p>
        <p class="text-lg font-semibold ${d.ga4.sessionsPct >= 0 ? "text-green-400" : "text-red-400"} mt-2">${d.ga4.sessionsPct >= 0 ? "+" : ""}${d.ga4.sessionsPct.toFixed(1)}%</p>
      </div>
    </div>
    ${d.ga4.topPages.length > 0 ? `
    <div class="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-gray-700">
      <h3 class="text-xl font-bold text-center mb-4 text-green-300">Top Pre-Market Landing Pages</h3>
      <div class="chart-container" style="height: 250px;"><canvas id="ga4Chart"></canvas></div>
    </div>` : ""}
  </section>` : ""}

</div>

<script>
window.addEventListener('load', () => {
  Chart.register(ChartDataLabels);
  const C = { purple: '#a78bfa', magenta: '#f472b6', blue: '#60a5fa', red: '#f87171', green: '#4ade80', white: '#FFF' };
  Chart.defaults.color = C.white;
  Chart.defaults.plugins.datalabels.color = C.white;
  Chart.defaults.plugins.datalabels.font = { weight: 'bold' };

  new Chart(document.getElementById('volumePieChart'), {
    type: 'doughnut',
    data: { labels: ['Filled', 'Unfilled'], datasets: [{ data: [${d.filledVolume}, ${unfilledVol}], backgroundColor: [C.blue, 'rgba(255,255,255,0.1)'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { formatter: (v) => (v * 100 / ${d.volumeOnWeb || 1}).toFixed(1) + '%' } } }
  });

  const gd = [
    ${d.prevVolumeOnWeb > 0 ? ((d.volumeOnWeb - d.prevVolumeOnWeb) / d.prevVolumeOnWeb * 100).toFixed(1) : 0},
    ${d.prevFilledVolume > 0 ? ((d.filledVolume - d.prevFilledVolume) / d.prevFilledVolume * 100).toFixed(1) : 0},
    ${d.prevTotalUsers > 0 ? ((d.totalUsers - d.prevTotalUsers) / d.prevTotalUsers * 100).toFixed(1) : 0},
    ${d.prevNewUsers > 0 ? ((d.newUsers - d.prevNewUsers) / d.prevNewUsers * 100).toFixed(1) : 0},
    ${d.prevOldUsers > 0 ? ((d.oldUsers - d.prevOldUsers) / d.prevOldUsers * 100).toFixed(1) : 0},
  ];
  new Chart(document.getElementById('growthBarChart'), {
    type: 'bar',
    data: { labels: ['Web Vol', 'Filled', 'Users', 'New', 'Old'], datasets: [{ data: gd, backgroundColor: gd.map(v => v < 0 ? C.red : C.green) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, datalabels: { formatter: v => v.toFixed(1) + '%', anchor: 'center' } } }
  });

  new Chart(document.getElementById('userDoughnutChart'), {
    type: 'doughnut',
    data: { labels: ['New', 'Old'], datasets: [{ data: [${d.newUsers}, ${d.oldUsers}], backgroundColor: [C.blue, C.magenta], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { formatter: v => v } } }
  });

  new Chart(document.getElementById('tokenBarChart'), {
    type: 'bar',
    data: { labels: ${JSON.stringify(d.topTokens.slice(0, 8).map(t => t.symbol))}, datasets: [{ data: ${JSON.stringify(d.topTokens.slice(0, 8).map(t => t.volume))}, backgroundColor: C.blue }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, datalabels: { formatter: v => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(1)+'K' : '$'+v, anchor: 'end', align: 'top', font: { size: 10 } } } }
  });

  ${activityData.length > 1 ? `
  new Chart(document.getElementById('activityChart'), {
    type: 'bar',
    data: { labels: ${JSON.stringify(activityLabels)}, datasets: [{ label: 'Volume', data: ${JSON.stringify(activityData)}, backgroundColor: '#3b82f6', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, datalabels: { formatter: v => v >= 1e3 ? '$'+(v/1e3).toFixed(1)+'K' : '$'+v, anchor: 'end', align: 'top', font: { size: 10 } } }, scales: { x: { grid: { display: false } }, y: { ticks: { callback: v => '$'+(v/1e3).toFixed(0)+'K' }, grid: { color: 'rgba(255,255,255,0.05)' } } } }
  });` : ""}

  ${d.socialData?.topPosts?.length ? `
  new Chart(document.getElementById('socialChart'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(d.socialData.topPosts.map(p => p.content.slice(0, 20) + "..."))},
      datasets: [
        { label: 'Likes', data: ${JSON.stringify(d.socialData.topPosts.map(p => p.likes))}, backgroundColor: C.magenta },
        { label: 'RT', data: ${JSON.stringify(d.socialData.topPosts.map(p => p.retweets))}, backgroundColor: C.purple },
        { label: 'Saves', data: ${JSON.stringify(d.socialData.topPosts.map(p => p.bookmarks))}, backgroundColor: C.blue },
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { stacked: true, grid: { display: false } } },
      plugins: { legend: { position: 'top' }, datalabels: { formatter: v => v > 0 ? v : '', font: { size: 9 } } }
    }
  });` : ""}

  ${d.ga4?.topPages?.length ? `
  new Chart(document.getElementById('ga4Chart'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(d.ga4.topPages.map(p => "$" + p.token))},
      datasets: [{ label: 'Sessions', data: ${JSON.stringify(d.ga4.topPages.map(p => p.sessions))}, backgroundColor: C.green }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, datalabels: { anchor: 'end', align: 'top', font: { size: 11 } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(255,255,255,0.05)' } } }
    }
  });` : ""}
});
<\/script>
</body>
</html>`;

  const filename = `${d.period}-report-${d.dateRange.split("→")[0]?.trim() || new Date().toISOString().slice(0, 10)}.html`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, html);
  return filepath;
}
