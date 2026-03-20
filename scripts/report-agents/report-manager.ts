import { findOrCreateDailyIssue, getComments, closeIssue, addComment } from "./lib/paperclip-api.js";
import { sendTelegram } from "./lib/telegram.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

interface SourceData {
  social?: any;
  ga?: any;
  validation?: any;
}

function parseComments(comments: Array<{ body: string }>): SourceData {
  const data: SourceData = {};
  for (const c of comments) {
    const body = c.body;
    if (body.includes("<!-- source:social -->")) {
      data.social = JSON.parse(body.replace("<!-- source:social -->", "").trim());
    } else if (body.includes("<!-- source:ga -->")) {
      data.ga = JSON.parse(body.replace("<!-- source:ga -->", "").trim());
    } else if (body.includes("<!-- source:validation -->")) {
      data.validation = JSON.parse(body.replace("<!-- source:validation -->", "").trim());
    }
  }
  return data;
}

function formatSocialSection(social: any): string {
  const lines: string[] = ["━━━ 📱 Social (X) ━━━\n"];
  for (const account of social.accounts ?? []) {
    lines.push(`<b>@${account.name}:</b>`);
    lines.push(`Posts: ${account.total_posts} | Avg Views: ${moneySmart(account.avg_views, "")}`);
    if (account.best_post) {
      lines.push(`Best: "${account.best_post.summary}"`);
      lines.push(`  → ${account.best_post.likes} ❤️ | ${account.best_post.retweets} 🔄 | ${account.best_post.replies} 💬 | ${moneySmart(account.best_post.views, "")} views`);
    }
    const eng = account.engagement ?? {};
    const parts = Object.entries(eng).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${v} ${k}`);
    if (parts.length) lines.push(`Engagement: ${parts.join(" / ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatGASection(ga: any): string {
  const lines: string[] = ["━━━ 🌐 Website (GA4) ━━━"];
  lines.push(`Active Users: ${moneySmart(ga.activeUsers, "")} (${growthBadge(ga.activeUsersPctChange)})`);
  lines.push(`New Users: ${moneySmart(ga.newUsers, "")} (${growthBadge(ga.newUsersPctChange)})`);
  lines.push(`Events: ${moneySmart(ga.eventCount, "")} (${growthBadge(ga.eventCountPctChange)})`);
  const countries = (ga.topCountries ?? []).map((c: any) => `${c.country} (${c.activeUsers})`).join(", ");
  if (countries) lines.push(`Top Countries: ${countries}`);
  return lines.join("\n");
}

function formatValidationSection(validation: any): string {
  if (!validation || validation.status === "pass") {
    return "━━━ ✅ Data Quality ━━━\nStatus: Clean ✓";
  }
  const lines = ["━━━ ⚠️ Data Quality ━━━"];
  lines.push(`Status: ${validation.warnings?.length ?? 0} warnings`);
  for (const w of validation.warnings ?? []) {
    lines.push(`• ${w}`);
  }
  return lines.join("\n");
}

async function main() {
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  if (!agentId) throw new Error("Missing PAPERCLIP_AGENT_ID");

  const issue = await findOrCreateDailyIssue(agentId);
  const comments = await getComments(issue.id);
  const data = parseComments(comments);

  // Check preconditions: need validation comment (which means collectors are done)
  if (!data.validation) {
    console.log("Report Manager: validation not ready, skipping cycle");
    process.exit(0);
  }

  // Check if already sent (look for "report_sent" comment)
  const alreadySent = comments.some((c) => c.body.includes("<!-- report_sent -->"));
  if (alreadySent) {
    console.log("Report Manager: report already sent today, skipping");
    process.exit(0);
  }

  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit", month: "2-digit", year: "numeric",
  }).replace(/\//g, "/");

  const sections: string[] = [`📊 <b>Whales Market Daily Report — ${today}</b>\n`];

  if (data.social) sections.push(formatSocialSection(data.social));
  else sections.push("━━━ 📱 Social (X) ━━━\n⚠️ Data unavailable\n");

  if (data.ga) sections.push(formatGASection(data.ga));
  else sections.push("━━━ 🌐 Website (GA4) ━━━\n⚠️ Data unavailable\n");

  sections.push(formatValidationSection(data.validation));

  const message = sections.join("\n\n");

  console.log("Report Manager: sending Telegram...");
  await sendTelegram(message);

  // Mark as sent
  await addComment(issue.id, "<!-- report_sent -->\nDaily report sent ✓");
  await closeIssue(issue.id);

  console.log("Report Manager: done ✓");
}

main().catch((err) => {
  console.error("Report Manager failed:", err);
  process.exit(1);
});
