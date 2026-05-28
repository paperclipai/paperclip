import { SlackClient } from "../src/core/slack-client.js";

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL ?? "bb-rfp-sourcing";
  if (!token) throw new Error("SLACK_BOT_TOKEN missing in .env");

  const slack = new SlackClient({ botToken: token });

  console.log("auth.test ...");
  const auth = await slack.authTest();
  console.log("  user:", auth.user, "team:", auth.team, "bot:", auth.botId);

  // Try posting with channel name directly — chat.postMessage accepts names server-side
  // and echoes the resolved channel ID back in the response.
  console.log(`postMessage (using channel name "#${channel}") ...`);
  const res = await slack.postMessage({
    channelId: `#${channel}`,
    text:
      ":wrench: govbids daily pipeline — Slack integration smoke test from " +
      new Date().toLocaleString(),
  });
  console.log("  posted ts:", res.ts);
  console.log("  channel ID echoed by Slack:", res.channel);
  console.log("\n→ Add to .env: SLACK_CHANNEL_ID=" + res.channel);
}

main().catch((err: Error) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
