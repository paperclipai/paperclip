import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { sendTelegram } from "./lib/telegram.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function main() {
  console.log("GA Collector: fetching GA4 metrics...");
  const m = await fetchGA4Metrics();

  const lines: string[] = [];
  lines.push(`<b>🌐 Whales Market — Website Daily Report</b>\n`);

  // Core metrics
  lines.push(`👥 Active Users: <b>${moneySmart(m.activeUsers, "")}</b> (${growthBadge(m.activeUsersPctChange)})`);
  lines.push(`🆕 New Users: <b>${moneySmart(m.newUsers, "")}</b> (${growthBadge(m.newUsersPctChange)})`);
  lines.push(`📊 Sessions: <b>${moneySmart(m.sessions, "")}</b> (${growthBadge(m.sessionsPctChange)})`);
  lines.push(`⚡ Events: <b>${moneySmart(m.eventCount, "")}</b> (${growthBadge(m.eventCountPctChange)})`);
  lines.push(`⏱ Avg Session: <b>${fmtDuration(m.avgSessionDuration)}</b> (${growthBadge(m.avgSessionDurationPctChange)})`);
  lines.push(`↩️ Bounce Rate: <b>${m.bounceRate.toFixed(1)}%</b> (${growthBadge(m.bounceRatePctChange)})`);

  // Dimensions
  if (m.devices.length > 0) {
    const devs = m.devices.map((d: any) => `${d.device} (${d.users})`).join(", ");
    lines.push(`\n📱 <b>Devices:</b> ${devs}`);
  }

  if (m.topCountries.length > 0) {
    const countries = m.topCountries.map((c: any) => `${c.country} (${c.activeUsers})`).join(", ");
    lines.push(`🌍 <b>Countries:</b> ${countries}`);
  }

  if (m.trafficSources.length > 0) {
    const sources = m.trafficSources.map((s: any) => `${s.source} (${s.sessions})`).join(", ");
    lines.push(`🔗 <b>Traffic:</b> ${sources}`);
  }

  if (m.topPages.length > 0) {
    lines.push(`\n📄 <b>Top Pages:</b>`);
    m.topPages.forEach((p: any) => lines.push(`  ${p.page} — ${p.views} views`));
  }

  if (m.topLandingPages.length > 0) {
    lines.push(`\n🚪 <b>Landing Pages:</b>`);
    m.topLandingPages.forEach((p: any) => lines.push(`  ${p.page} — ${p.sessions} sessions`));
  }

  if (m.topReferrals.length > 0) {
    const refs = m.topReferrals.map((r: any) => `${r.referrer} (${r.sessions})`).join(", ");
    lines.push(`\n🔀 <b>Referrals:</b> ${refs}`);
  }

  console.log("GA Collector: sending Telegram...");
  await sendTelegram(lines.join("\n"));

  console.log("GA Collector: done ✓");
}

main().catch((err) => {
  console.error("GA Collector failed:", err);
  process.exit(1);
});
