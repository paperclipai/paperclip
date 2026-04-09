import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { execSync } from "node:child_process";

// --- Config ---
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;   // xapp-...
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;   // xoxb-...
const WATCH_CHANNELS = (process.env.WATCH_CHANNELS || "").split(",").filter(Boolean);
const CEO_AGENT_ID = "9a5b9dc6-068c-4702-b3ff-d97fb162c290";
const COMPANY_ID = "a9d33dc4-ba89-4162-8550-178a7d639a7b";
const PAPERCLIP_CLI = "/opt/homebrew/bin/paperclipai";
const PAPERCLIP_URL = "http://localhost:3100";

if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
  console.error("Missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN");
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);
const socket = new SocketModeClient({ appToken: SLACK_APP_TOKEN });

// Track processed messages to avoid duplicates
const processed = new Set();

// Channel ID → name cache
const channelNames = new Map();
async function getChannelName(id) {
  if (channelNames.has(id)) return channelNames.get(id);
  try {
    const info = await slack.conversations.info({ channel: id });
    const name = info.channel.name;
    channelNames.set(id, name);
    return name;
  } catch { return id; }
}

// User ID → name cache
const userNames = new Map();
async function getUserName(id) {
  if (userNames.has(id)) return userNames.get(id);
  try {
    const info = await slack.users.info({ user: id });
    const name = info.user.real_name || info.user.name;
    userNames.set(id, name);
    return name;
  } catch { return id; }
}

// Create Paperclip issue via CLI
function createIssue(title, description) {
  try {
    const result = execSync(
      `${PAPERCLIP_CLI} issue create -C ${COMPANY_ID} ` +
      `--title "${title.replace(/"/g, '\\"')}" ` +
      `--description "${description.replace(/"/g, '\\"')}" ` +
      `--assignee-agent-id ${CEO_AGENT_ID} ` +
      `--priority medium ` +
      `--status todo --json`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error("Failed to create issue:", e.message);
    return null;
  }
}

socket.on("message", async ({ event, body, ack }) => {
  await ack();

  // Skip bot messages, edits, thread replies
  if (event.bot_id || event.subtype || event.thread_ts) return;

  // Skip if not in watched channels
  if (WATCH_CHANNELS.length > 0 && !WATCH_CHANNELS.includes(event.channel)) return;

  // Skip duplicates
  if (processed.has(event.ts)) return;
  processed.add(event.ts);

  // Cleanup old entries (keep last 500)
  if (processed.size > 500) {
    const arr = [...processed];
    arr.slice(0, arr.length - 500).forEach(ts => processed.delete(ts));
  }

  const channelName = await getChannelName(event.channel);
  const userName = await getUserName(event.user);
  const text = event.text || "(no text)";

  console.log(`[#${channelName}] ${userName}: ${text.substring(0, 100)}`);

  // Create issue
  const title = text.length > 80
    ? text.substring(0, 77) + "..."
    : text;

  const description = [
    `## Ze Slacku`,
    ``,
    `**Kanál:** #${channelName}`,
    `**Od:** ${userName}`,
    `**Čas:** ${new Date(parseFloat(event.ts) * 1000).toISOString()}`,
    ``,
    `## Zpráva`,
    ``,
    text,
  ].join("\n");

  const issue = createIssue(title, description);

  if (issue) {
    console.log(`  → Created ${issue.identifier}`);

    // React with eyes to confirm we saw it
    try { await slack.reactions.add({ channel: event.channel, name: "eyes", timestamp: event.ts }); } catch {}

    // Reply in thread with issue link
    try {
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `✅ Vytvořen úkol *${issue.identifier}*: ${PAPERCLIP_URL}/KOM/issues/${issue.identifier}`,
      });
    } catch (e) {
      console.error("Failed to reply:", e.message);
    }
  }
});

socket.on("connected", () => {
  console.log("Slack bridge connected. Watching for messages...");
  if (WATCH_CHANNELS.length > 0) {
    console.log("Channels:", WATCH_CHANNELS.join(", "));
  } else {
    console.log("Watching ALL channels where bot is invited.");
  }
});

socket.on("error", (err) => {
  console.error("Socket error:", err.message);
});

await socket.start();
