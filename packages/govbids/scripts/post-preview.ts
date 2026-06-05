import { SlackClient } from "../src/core/slack-client.js";

async function main() {
  const token = process.env.SLACK_BOT_TOKEN!;
  const channelId = process.env.SLACK_CHANNEL_ID!;
  const xlsx = process.argv[2];
  const slack = new SlackClient({ botToken: token });
  const comment = [
    ":sparkles: *Pipeline tuning update — preview before tomorrow's 7 AM run*",
    "Applied the 5 changes from your feedback:",
    "• :unlock: License/subscription/renewal RFPs now sourced (Oracle/M365/New Relic licenses, maintenance renewals)",
    "• :no_entry_sign: Pure website design/redesign/CMS now down-ranked out of the cut (kept if part of a larger system)",
    "• :calendar: New *Released* + *Days Since Released* columns; rows sorted freshest-first",
    "• :mag: Broader system/ERP keyword coverage",
    "• :paperclip: Addenda/re-posts now in a separate *'Addenda & Updates'* tab — they no longer inflate the new-RFP count",
    "",
    "This sheet: *18 new qualified RFPs* + *2 addenda/updates* (see second tab). Open in Excel to review the new format.",
  ].join("\n");
  await slack.uploadFile({ channelId, filePath: xlsx, title: "Qualified RFPs — tuning preview", initialComment: comment });
  console.log("posted preview to Slack");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
