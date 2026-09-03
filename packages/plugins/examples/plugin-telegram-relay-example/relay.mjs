#!/usr/bin/env node
/**
 * Telegram → Paperclip real-time relay.
 *
 * Uses Telegram long-polling (getUpdates with timeout=30) so comments
 * are posted within seconds of a message arriving. Sends a quick
 * acknowledgment ("pulse") back to the Telegram chat so the user
 * knows the message was received before the agent starts working.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token>            \
 *   TELEGRAM_CHAT_ID=<chat_id>            \
 *   PAPERCLIP_BASE=http://127.0.0.1:3100  \
 *   PAPERCLIP_API_KEY=<bearer-token>      \
 *   RELAY_ISSUE_ID=<issue-uuid>           \
 *   AGENT_MENTION=@CEO                    \
 *   node relay.mjs
 *
 * All values are read from environment variables. None are hard-coded.
 */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PAPERCLIP_BASE = "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY = "",
  RELAY_ISSUE_ID,
  AGENT_MENTION = "",
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !RELAY_ISSUE_ID) {
  console.error(
    "Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RELAY_ISSUE_ID",
  );
  process.exit(1);
}

const PULSE_MESSAGES = [
  "Got it — on it now.",
  "Received. Working on it.",
  "Roger that, processing.",
  "Message received — firing up the agents.",
  "Heard you loud and clear. Working.",
];

let offset = 0;

/** Send a quick acknowledgment back to the Telegram user. */
async function sendPulse(chatId) {
  const text =
    PULSE_MESSAGES[Math.floor(Math.random() * PULSE_MESSAGES.length)];
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
  } catch (err) {
    console.error("Failed to send pulse:", err.message);
  }
}

async function poll() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("Telegram HTTP error:", resp.status, await resp.text());
    return;
  }
  const data = await resp.json();
  if (!data.ok) {
    console.error("Telegram error:", data);
    return;
  }

  for (const update of data.result) {
    offset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;
    if (String(msg.chat?.id) !== TELEGRAM_CHAT_ID) continue;

    const sender = [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ") || "Unknown";

    const mention = AGENT_MENTION ? `${AGENT_MENTION} ` : "";
    const body = `${mention}**Telegram from ${sender}:**\n\n${msg.text}`;

    console.log(`[${new Date().toISOString()}] ${sender}: ${msg.text}`);

    // Send pulse acknowledgment and post comment concurrently
    const headers = { "Content-Type": "application/json" };
    if (PAPERCLIP_API_KEY) {
      headers["Authorization"] = `Bearer ${PAPERCLIP_API_KEY}`;
    }

    const commentPromise = fetch(
      `${PAPERCLIP_BASE}/api/issues/${RELAY_ISSUE_ID}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      },
    ).then(async (res) => {
      if (!res.ok) {
        console.error("Paperclip error:", res.status, await res.text());
      } else {
        console.log("  → Comment posted");
      }
    }).catch((err) => {
      console.error("Failed to post comment:", err.message);
    });

    const pulsePromise = sendPulse(msg.chat.id);

    await Promise.all([commentPromise, pulsePromise]);
  }
}

let running = true;

function shutdown() {
  console.log("\nShutting down relay...");
  running = false;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Telegram relay started — listening for messages...");

while (running) {
  try {
    await poll();
  } catch (err) {
    console.error("Poll error:", err.message);
    if (running) await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log("Relay stopped.");
