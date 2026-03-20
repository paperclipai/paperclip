import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { sendTelegram } from "./lib/telegram.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

async function main() {
  console.log("GA Collector: fetching GA4 metrics...");
  const metrics = await fetchGA4Metrics();

  // Format Telegram message
  const lines: string[] = [];
  lines.push(`<b>🌐 Whales Market — Website Report</b>\n`);
  lines.push(`Active Users: <b>${moneySmart(metrics.activeUsers, "")}</b> (${growthBadge(metrics.activeUsersPctChange)})`);
  lines.push(`New Users: <b>${moneySmart(metrics.newUsers, "")}</b> (${growthBadge(metrics.newUsersPctChange)})`);
  lines.push(`Events: <b>${moneySmart(metrics.eventCount, "")}</b> (${growthBadge(metrics.eventCountPctChange)})`);

  if (metrics.topCountries.length > 0) {
    const countries = metrics.topCountries.map((c) => `${c.country} (${c.activeUsers})`).join(", ");
    lines.push(`Top Countries: ${countries}`);
  }

  if (metrics.trafficSources.length > 0) {
    const sources = metrics.trafficSources.map((s) => `${s.source} (${s.sessions})`).join(", ");
    lines.push(`Traffic: ${sources}`);
  }

  console.log("GA Collector: sending Telegram...");
  await sendTelegram(lines.join("\n"));

  console.log("GA Collector: done ✓");
}

main().catch((err) => {
  console.error("GA Collector failed:", err);
  process.exit(1);
});
