import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { execSync } from "node:child_process";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const WATCH_CHANNELS = (process.env.WATCH_CHANNELS || "").split(",").filter(Boolean);
const CEO_AGENT_ID = "9a5b9dc6-068c-4702-b3ff-d97fb162c290";
const COMPANY_ID = "a9d33dc4-ba89-4162-8550-178a7d639a7b";
const PAPERCLIP_CLI = "/opt/homebrew/bin/paperclipai";
const POLL_INTERVAL_MS = 60_000;

if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
  console.error("Missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN");
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);
const socket = new SocketModeClient({ appToken: SLACK_APP_TOKEN });

// Track: issueId -> { channel, ts, identifier }
const pendingCheckmarks = new Map();
const processed = new Set();

const channelNames = new Map();
async function getChannelName(id) {
  if (channelNames.has(id)) return channelNames.get(id);
  try {
    const info = await slack.conversations.info({ channel: id });
    channelNames.set(id, info.channel.name);
    return info.channel.name;
  } catch { return id; }
}

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

function createIssue(title, description) {
  try {
    const result = execSync(
      `${PAPERCLIP_CLI} issue create -C ${COMPANY_ID} ` +
      `--title "${title.replace(/"/g, '\\"')}" ` +
      `--description "${description.replace(/"/g, '\\"')}" ` +
      `--assignee-agent-id ${CEO_AGENT_ID} ` +
      `--priority medium --status todo --json`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error("Failed to create issue:", e.message);
    return null;
  }
}

function getLastComment(issueId) {
  try {
    const result = execSync(
      `${PAPERCLIP_CLI} activity list -C ${COMPANY_ID} --json`,
      { encoding: "utf-8", timeout: 30000 }
    );
    const activities = JSON.parse(result);
    for (const a of activities) {
      if (a.entityId === issueId && a.action === "issue.comment_added" && a.agentId) {
        return a.details?.bodySnippet || null;
      }
    }
  } catch {}
  return null;
}

async function pollCompletedIssues() {
  if (pendingCheckmarks.size === 0) return;

  try {
    const result = execSync(
      `${PAPERCLIP_CLI} issue list -C ${COMPANY_ID} --json`,
      { encoding: "utf-8", timeout: 30000 }
    );
    const issues = JSON.parse(result);

    for (const issue of issues) {
      if (!pendingCheckmarks.has(issue.id)) continue;
      const { channel, ts, identifier } = pendingCheckmarks.get(issue.id);

      if (issue.status === "done") {
        console.log(`  done ${identifier}`);
        try { await slack.reactions.remove({ channel, name: "eyes", timestamp: ts }); } catch {}
        try { await slack.reactions.add({ channel, name: "white_check_mark", timestamp: ts }); } catch {}
        pendingCheckmarks.delete(issue.id);

      } else if (issue.status === "blocked") {
        console.log(`  blocked ${identifier}`);
        // Add warning emoji
        try { await slack.reactions.add({ channel, name: "warning", timestamp: ts }); } catch {}

        // Get last agent comment and reply in thread
        const lastComment = getLastComment(issue.id);
        if (lastComment) {
          try {
            await slack.chat.postMessage({
              channel,
              thread_ts: ts,
              text: `:warning: *${identifier}* je blokovaný:\n${lastComment.substring(0, 500)}`,
            });
          } catch (e) {
            console.error("Failed to reply:", e.message);
          }
        }
        // Keep tracking - might become done later
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }
}

setInterval(pollCompletedIssues, POLL_INTERVAL_MS);

socket.on("message", async ({ event, body, ack }) => {
  await ack();
  if (event.bot_id || event.subtype || event.thread_ts) return;
  if (WATCH_CHANNELS.length > 0 && !WATCH_CHANNELS.includes(event.channel)) return;
  if (processed.has(event.ts)) return;
  processed.add(event.ts);
  if (processed.size > 500) {
    const arr = [...processed];
    arr.slice(0, arr.length - 500).forEach(ts => processed.delete(ts));
  }

  const channelName = await getChannelName(event.channel);
  const userName = await getUserName(event.user);
  const text = event.text || "(no text)";
  console.log(`[${channelName}] ${userName}: ${text.substring(0, 100)}`);

  const title = text.length > 80 ? text.substring(0, 77) + "..." : text;
  const description = [
    "## Ze Slacku", "",
    `**Kanal:** #${channelName}`,
    `**Od:** ${userName}`,
    `**Cas:** ${new Date(parseFloat(event.ts) * 1000).toISOString()}`,
    "", "## Zprava", "", text,
  ].join("\n");

  const issue = createIssue(title, description);
  if (issue) {
    console.log(`  -> ${issue.identifier}`);
    try { await slack.reactions.add({ channel: event.channel, name: "eyes", timestamp: event.ts }); } catch {}
    pendingCheckmarks.set(issue.id, { channel: event.channel, ts: event.ts, identifier: issue.identifier });
  }
});

socket.on("connected", () => {
  console.log("Slack bridge connected.");
  console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);
});

socket.on("error", (err) => console.error("Socket error:", err.message));

await socket.start();
