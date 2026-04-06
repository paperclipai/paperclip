// charts.ts
// Generate chart images via QuickChart.io API (free, no dependencies)
// Returns PNG buffer ready to send via Telegram sendPhoto

const QUICKCHART_API = "https://quickchart.io/chart";

interface ChartConfig {
  type: "bar" | "line" | "doughnut" | "pie" | "horizontalBar";
  data: {
    labels: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      borderWidth?: number;
      fill?: boolean;
    }>;
  };
  options?: Record<string, unknown>;
}

export async function generateChart(config: ChartConfig, width = 600, height = 400): Promise<Buffer> {
  const url = `${QUICKCHART_API}?c=${encodeURIComponent(JSON.stringify(config))}&w=${width}&h=${height}&bkg=white&f=png`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`QuickChart error: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================
// PRE-BUILT CHARTS for Whales Market
// ============================================================

export async function volumeBarChart(tokens: Array<{ symbol: string; volume: number }>): Promise<Buffer> {
  return generateChart({
    type: "horizontalBar",
    data: {
      labels: tokens.map((t) => `$${t.symbol}`),
      datasets: [{
        label: "Filled Volume (USD)",
        data: tokens.map((t) => Math.round(t.volume)),
        backgroundColor: "rgba(54, 162, 235, 0.8)",
        borderColor: "rgba(54, 162, 235, 1)",
        borderWidth: 1,
      }],
    },
    options: {
      title: { display: true, text: "Top Tokens by 24h Filled Volume", fontSize: 16 },
      scales: { xAxes: [{ ticks: { callback: "function(v){return '$'+v.toLocaleString()}" } }] },
      plugins: { datalabels: { display: true, anchor: "end", align: "right", formatter: "function(v){return '$'+(v/1000).toFixed(1)+'K'}" } },
    },
  });
}

export async function dailyTrendChart(days: Array<{ date: string; volume: number; orders: number }>): Promise<Buffer> {
  return generateChart({
    type: "line",
    data: {
      labels: days.map((d) => d.date.slice(5)), // MM-DD
      datasets: [
        {
          label: "Volume (USD)",
          data: days.map((d) => Math.round(d.volume)),
          borderColor: "rgba(54, 162, 235, 1)",
          backgroundColor: "rgba(54, 162, 235, 0.1)",
          fill: true,
          borderWidth: 2,
        },
        {
          label: "Orders",
          data: days.map((d) => d.orders),
          borderColor: "rgba(255, 99, 132, 1)",
          backgroundColor: "rgba(255, 99, 132, 0.1)",
          fill: false,
          borderWidth: 2,
        },
      ],
    },
    options: {
      title: { display: true, text: "Daily Volume & Orders Trend", fontSize: 16 },
      scales: {
        yAxes: [
          { id: "y", position: "left", ticks: { callback: "function(v){return '$'+(v/1000).toFixed(0)+'K'}" } },
        ],
      },
    },
  }, 700, 400);
}

export async function userPieChart(newUsers: number, returningUsers: number): Promise<Buffer> {
  return generateChart({
    type: "doughnut",
    data: {
      labels: ["New Users", "Returning Users"],
      datasets: [{
        data: [newUsers, returningUsers],
        backgroundColor: ["rgba(75, 192, 192, 0.8)", "rgba(153, 102, 255, 0.8)"],
        borderWidth: 2,
      }],
    },
    options: {
      title: { display: true, text: "New vs Returning Users", fontSize: 16 },
      plugins: {
        datalabels: {
          display: true,
          formatter: "function(v, ctx){var sum=ctx.dataset.data.reduce(function(a,b){return a+b},0);return (v/sum*100).toFixed(0)+'%'}",
        },
      },
    },
  }, 400, 400);
}

export async function trafficSourcesChart(sources: Array<{ source: string; sessions: number }>): Promise<Buffer> {
  return generateChart({
    type: "doughnut",
    data: {
      labels: sources.map((s) => s.source),
      datasets: [{
        data: sources.map((s) => s.sessions),
        backgroundColor: [
          "rgba(54, 162, 235, 0.8)",
          "rgba(255, 206, 86, 0.8)",
          "rgba(75, 192, 192, 0.8)",
          "rgba(153, 102, 255, 0.8)",
          "rgba(255, 99, 132, 0.8)",
        ],
        borderWidth: 2,
      }],
    },
    options: {
      title: { display: true, text: "Traffic Sources", fontSize: 16 },
    },
  }, 400, 400);
}
