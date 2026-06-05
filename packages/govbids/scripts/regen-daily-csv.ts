/**
 * Regenerate the lawyer CSV for a given day from its saved scored-{date}.json,
 * applying the latest fixes (RFPMart agency parsing + MSP tier promotion),
 * then post the corrected version to Slack as "v2 — corrected".
 *
 * Does NOT re-fetch or re-score. Uses what's already on disk.
 *
 * Usage: npx tsx scripts/regen-daily-csv.ts [YYYY-MM-DD]
 */
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeLawyerCsv, writeLawyerXlsx, writeCsv } from "../src/cli/output.js";
import { SlackClient } from "../src/core/slack-client.js";
import { getStateDir } from "../src/cli/state.js";
import { markSeen, loadSeenStore, saveSeenStore } from "../src/cli/seen-set.js";
import type { PipelineResult, ScoredOpportunity } from "../src/core/types.js";

/** Same USA-prefix parser as the RFPMart normalizer, applied here to existing
 * scored data so we don't have to re-fetch. Returns cleaned title + agency. */
function reparseRfpMartAgency(opp: ScoredOpportunity): ScoredOpportunity {
  if (!opp.id.startsWith("rfpmart-")) return opp;
  if (opp.agency && opp.agency !== "RFPMart Source") return opp;

  const m = opp.title.match(/^USA\s*\(([^)]+)\)\s*[-–—]\s*(.+)$/i);
  if (m) {
    return { ...opp, title: m[2].trim(), agency: m[1].trim() };
  }
  return { ...opp, agency: "RFPMart (agency in title)" };
}

async function main() {
  const dateStr = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dataDir = getStateDir();
  const dailyDir = join(dataDir, "daily");
  const sourceJson = join(dailyDir, `scored-${dateStr}.json`);

  console.log(`Loading ${sourceJson} ...`);
  const raw = await readFile(sourceJson, "utf-8");
  const data = JSON.parse(raw) as PipelineResult;

  const minScore = 60;
  const cleaned = data.scored.map(reparseRfpMartAgency);
  const strictQualified = cleaned
    .filter(
      (o) => o.score >= minScore && (!o.disqualifiers || o.disqualifiers.length === 0),
    )
    .sort((a, b) => b.score - a.score);

  // Seed the seen-set with today's emissions so tomorrow's daily run suppresses these.
  const seenStore = await loadSeenStore();
  const startSize = Object.keys(seenStore.entries).length;
  markSeen(strictQualified, seenStore);
  await saveSeenStore(seenStore);
  const endSize = Object.keys(seenStore.entries).length;
  console.log(
    `  seen-set: ${startSize} → ${endSize} (${endSize - startSize} new IDs marked)`,
  );

  await mkdir(dailyDir, { recursive: true });
  const versionTag = process.env.REGEN_VERSION_TAG ?? "v3";
  const lawyerXlsx = join(
    dailyDir,
    `qualified-${dateStr}-for-team-${versionTag}.xlsx`,
  );
  const lawyerCsv = join(dailyDir, `qualified-${dateStr}-for-team-${versionTag}.csv`);
  const fullCsv = join(dailyDir, `qualified-${dateStr}-full-${versionTag}.csv`);
  await writeLawyerXlsx(strictQualified, lawyerXlsx);
  await writeLawyerCsv(strictQualified, lawyerCsv);
  await writeCsv(strictQualified, fullCsv);
  console.log(`  wrote ${lawyerXlsx}`);
  console.log(`  wrote ${lawyerCsv}`);
  console.log(`  wrote ${fullCsv}`);

  // Count promotions for the Slack summary
  const greenCount = strictQualified.filter((o) => {
    const isCore =
      o.serviceCategory === "managed-it" || o.serviceCategory === "cybersecurity";
    const promoted = isCore && o.scoreBreakdown.serviceAlignment >= 35;
    return promoted || o.score >= 80;
  }).length;

  // Post to Slack
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) {
    console.log("Skipping Slack post — token or channel ID missing.");
    return;
  }
  const slack = new SlackClient({ botToken: token });

  const top3 = strictQualified
    .slice(0, 3)
    .map((o) => {
      const due = o.dueDate ? new Date(o.dueDate).toLocaleDateString("en-US") : "—";
      const isCore =
        o.serviceCategory === "managed-it" || o.serviceCategory === "cybersecurity";
      const promoted = isCore && o.scoreBreakdown.serviceAlignment >= 35;
      const tier = promoted || o.score >= 80 ? ":large_green_circle:" : ":large_yellow_circle:";
      return `${tier} *${o.score}* — ${o.title} (${o.agency}, ${o.state ?? "—"}) — due ${due}`;
    })
    .join("\n");

  const initialComment = [
    `:repeat: *Corrected RFP digest — ${dateStr}* (${versionTag})`,
    `Applied fixes based on team feedback on the morning sheet:`,
    `• :file_folder: Now delivered as a formatted Excel workbook (color-coded tier, clickable links, frozen header, auto-filter)`,
    `• :pencil2: RFPMart agency names parsed from title (no more "RFPMart Source")`,
    `• :large_green_circle: MSP/IT-Services/Cybersecurity bids with strong service fit promoted to GREEN`,
    `• :repeat: Persistent seen-set seeded — tomorrow's run will suppress today's ${strictQualified.length} entries unless due-date shifts or it's the day-of-deadline`,
    "",
    `*${strictQualified.length}* qualified RFPs · *${greenCount}* now GREEN (vs 9 in the morning sheet)`,
    "",
    `*Top 3:*`,
    top3,
  ].join("\n");

  await slack.uploadFile({
    channelId,
    filePath: lawyerXlsx,
    title: `Qualified RFPs ${dateStr} (${versionTag} — corrected)`,
    initialComment,
  });
  console.log("  posted to Slack with Excel file attached.");
}

main().catch((err: Error) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
