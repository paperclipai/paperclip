import { writeLawyerXlsx } from "../src/cli/output.js";
import { classifyOpportunity } from "../src/core/classify.js";
import { SlackClient } from "../src/core/slack-client.js";
import { tierOf } from "../src/cli/output.js";
import type { ScoredOpportunity } from "../src/core/types.js";
import { readFileSync } from "node:fs";

async function main() {
  const date = process.argv[2] ?? "2026-06-03";
  const data: ScoredOpportunity[] = JSON.parse(
    readFileSync(`data/daily/scored-${date}.json`, "utf-8"),
  ).scored;
  const qual = data.filter(
    (o) => o.score >= 50 && (!o.disqualifiers || o.disqualifiers.length === 0),
  );
  const main: ScoredOpportunity[] = [], other: ScoredOpportunity[] = [], addenda: ScoredOpportunity[] = [];
  for (const o of qual) {
    const { type } = classifyOpportunity(o);
    if (type === "federal" || type === "job-posting" || type === "rfi") other.push(o);
    else if (type === "addendum") addenda.push(o);
    else if (type === "qanda") { /* dropped */ }
    else main.push(o);
  }
  main.sort((a, b) => b.score - a.score);
  const file = `data/daily/preview-${date}-new-format.xlsx`;
  await writeLawyerXlsx(main, file, addenda, other);

  const tiers = { GREEN: 0, YELLOW: 0, AMBER: 0 };
  for (const o of main) tiers[tierOf(o)]++;
  const otherByType = (t: string) => other.filter((o) => classifyOpportunity(o).type === t).length;

  const token = process.env.SLACK_BOT_TOKEN!, channel = process.env.SLACK_CHANNEL_ID!;
  const slack = new SlackClient({ botToken: token });
  const msg = [
    ":bar_chart: *Pipeline update — what's shipped over the last few iterations*",
    "",
    "Quick rundown of improvements now live (rolling out on tomorrow's 7 AM digest):",
    "",
    "*Data accuracy*",
    "• State codes fixed (was mislabeling e.g. a Texas RFP as Utah)",
    "• Duplicate RFPs sourced from two portals now collapse to one row",
    "• UN / non-US bids removed (~40/day of noise gone)",
    "",
    "*Sharper list*",
    "• GREEN tier now reliably flags well-scoped, in-capability RFPs",
    "• Concerns are specific now — no more vague \"unclear requirements\"",
    "• Re-posts & addenda of already-sourced RFPs no longer show as new (they go to an \"Addenda & Updates\" tab); Q&A docs dropped",
    "",
    "*New: every opportunity is now typed*",
    "• A new *Opportunity Type* column labels each row (RFP / RFI / Job Posting / Federal / Ongoing)",
    "• Federal, RFIs, and job postings move to a separate *\"Other Opportunity Types\"* tab — visible but out of your main Qualified list",
    "• Ongoing / as-needed master contracts (no fixed deadline) are now captured instead of dropped",
    "",
    `*Today's list in the new format (preview attached):*`,
    `• ${main.length} Qualified RFPs — :large_green_circle: ${tiers.GREEN} GREEN · :large_yellow_circle: ${tiers.YELLOW} YELLOW · :large_orange_circle: ${tiers.AMBER} AMBER`,
    `• ${other.length} moved to "Other" tab (RFI ${otherByType("rfi")}, Job Posting ${otherByType("job-posting")}, Federal ${otherByType("federal")})`,
    addenda.length ? `• ${addenda.length} in Addenda & Updates` : "",
    "",
    "Still on the roadmap: sourcing nonprofit RFPs and small-town/rural opportunities that aren't on the major portals (e.g. the Town of Kingsbury / Greenwood ones found manually) — that's a bigger build, scoping it next.",
    "",
    "Keep the feedback coming — it's directly shaping the tool. :pray:",
  ].filter(Boolean).join("\n");

  await slack.uploadFile({ channelId: channel, filePath: file, title: `RFP list — new format preview (${date})`, initialComment: msg });
  console.log(`Posted PM update + preview (${main.length} qualified, ${other.length} other, ${addenda.length} addenda)`);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
