import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { sendTelegram } from "./lib/telegram.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

async function main() {
  console.log("GA Collector: fetching GA4 metrics...");
  const m = await fetchGA4Metrics();

  const lines: string[] = [];
  lines.push(`<b>🌐 Whales Market — Website Daily Report</b>\n`);

  // Core metrics
  lines.push(`👥 Active Users: <b>${moneySmart(m.activeUsers, "")}</b> (${growthBadge(m.activeUsersPctChange)})`);
  lines.push(`🆕 New Users: <b>${moneySmart(m.newUsers, "")}</b> (${growthBadge(m.newUsersPctChange)})`);
  lines.push(`📊 Sessions: <b>${moneySmart(m.sessions, "")}</b> (${growthBadge(m.sessionsPctChange)})`);

  // Landing pages — only /en/premarket/... top 3
  const premarketPages = m.topLandingPages
    .filter((p: any) => /^\/en\/premarket\//.test(p.page))
    .slice(0, 3);
  if (premarketPages.length > 0) {
    lines.push(`\n🚪 <b>Top Pre-Market Landing Pages:</b>`);
    premarketPages.forEach((p: any) => {
      const token = p.page.replace("/en/premarket/", "");
      lines.push(`  $${token} — ${p.sessions} sessions`);
    });
  }

  console.log("GA Collector: sending Telegram...");
  await sendTelegram(lines.join("\n"));

  console.log("GA Collector: done ✓");
}

main().catch((err) => {
  console.error("GA Collector failed:", err);
  process.exit(1);
});
