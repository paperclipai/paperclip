// bot-listener.ts
// Long-polling Telegram bot with conversation memory
// /report triggers collectors, free text → Claude CLI with context

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import Database from "better-sqlite3";
import { sendTelegram } from "./lib/telegram.js";
import { fetchPlatformMetrics } from "./lib/metabase-queries.js";
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const WHALES_DB_PATH = process.env.WHALES_DB_PATH;
const TELEGRAM_API = "https://api.telegram.org";
let offset = 0;

// ============================================================
// SESSION MANAGEMENT — persistent Claude session per chat
// ============================================================

interface ChatSession {
  sessionId: string | null; // Claude CLI session ID
  lastActivity: number;
}

const chatSessions = new Map<string, ChatSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour — new session after inactivity

function getSession(chatKey: string): ChatSession {
  const session = chatSessions.get(chatKey);
  if (session && Date.now() - session.lastActivity < SESSION_TTL_MS) {
    session.lastActivity = Date.now();
    return session;
  }
  // New session
  const newSession: ChatSession = { sessionId: null, lastActivity: Date.now() };
  chatSessions.set(chatKey, newSession);
  return newSession;
}

// ============================================================
// TELEGRAM
// ============================================================

async function getUpdates(): Promise<any[]> {
  const res = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.result ?? [];
}

async function reply(chatId: string, text: string, threadId?: number): Promise<string> {
  await sendTelegram(text, { botToken: BOT_TOKEN!, chatId, threadId });
  return text;
}

// ============================================================
// /report command
// ============================================================

async function handleReport(chatId: string, threadId?: number) {
  await reply(chatId, "⏳ Generating reports...", threadId);

  if (WHALES_DB_PATH) {
    try {
      const tokens = fetchPlatformMetrics(WHALES_DB_PATH);
      if (tokens.length > 0) {
        const { buildPlatformHtml } = await import("./lib/platform-format.js");
        await reply(chatId, buildPlatformHtml(tokens), threadId);
      } else {
        await reply(chatId, "🐳 Platform: No data in last 24h", threadId);
      }
    } catch (e) {
      await reply(chatId, `🐳 Platform error: ${e}`, threadId);
    }
  }

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const SOCIAL_ACCOUNTS = process.env.SOCIAL_ACCOUNTS;
  if (RAPIDAPI_KEY && SOCIAL_ACCOUNTS) {
    try {
      const { runSocialCollector } = await import("./lib/social-format.js");
      const html = await runSocialCollector(RAPIDAPI_KEY, JSON.parse(SOCIAL_ACCOUNTS));
      if (html) await reply(chatId, html, threadId);
      else await reply(chatId, "📱 Social: No tweets from yesterday", threadId);
    } catch (e) {
      await reply(chatId, `📱 Social error: ${e}`, threadId);
    }
  }

  if (process.env.GA4_PROPERTY_ID) {
    try {
      const m = await fetchGA4Metrics();
      const lines = [
        `<b>🌐 Website Daily Report</b>\n`,
        `👥 Active Users: <b>${moneySmart(m.activeUsers, "")}</b> (${growthBadge(m.activeUsersPctChange)})`,
        `🆕 New Users: <b>${moneySmart(m.newUsers, "")}</b> (${growthBadge(m.newUsersPctChange)})`,
        `📊 Sessions: <b>${moneySmart(m.sessions, "")}</b> (${growthBadge(m.sessionsPctChange)})`,
      ];
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
      await reply(chatId, lines.join("\n"), threadId);
    } catch (e) {
      await reply(chatId, `🌐 GA error: ${e}`, threadId);
    }
  }
}

// ============================================================
// Free text Q&A with conversation context
// ============================================================

async function handleQuestion(chatId: string, question: string, chatKey: string, threadId?: number) {
  if (!WHALES_DB_PATH) {
    await reply(chatId, "❌ Q&A requires WHALES_DB_PATH", threadId);
    return;
  }

  await reply(chatId, "🤔 Thinking...", threadId);

  const session = getSession(chatKey);
  const isNewSession = !session.sessionId;

  // Build prompt — system prompt only on first message, then just the question
  let prompt: string;
  if (isNewSession) {
    prompt = `ĐỌC FILE SYSTEM PROMPT: /Users/amando/Desktop/Learn/metabase-sync/SYSTEM_PROMPT.md — làm theo hướng dẫn trong đó.
Database SQLite tại: ${WHALES_DB_PATH}

Câu hỏi: "${question}"`;
  } else {
    // Follow-up: just the question, Claude remembers context from session
    prompt = question;
  }

  try {
    // Build args: --print for output, -r for session resume, -p for prompt
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--model", "claude-sonnet-4-5-20250929",
    ];

    // Resume existing session if available
    if (session.sessionId) {
      args.push("-r", session.sessionId);
    }

    args.push("-p", prompt);

    const { stdout, stderr } = await execFileAsync("claude", args, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    });

    // Extract session ID from stderr (Claude CLI outputs session info there)
    const sessionMatch = stderr?.match(/session_id[=:]\s*([a-f0-9-]+)/i)
      || stderr?.match(/Resuming session ([a-f0-9-]+)/i)
      || stdout?.match(/"session_id"\s*:\s*"([a-f0-9-]+)"/);

    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      console.log(`  [${chatKey}] Session: ${session.sessionId?.slice(0, 8)}...`);
    }

    // If --print didn't capture session, try to extract from output
    if (!session.sessionId && isNewSession) {
      // Run a quick command to get the last session ID
      try {
        const { stdout: lsOut } = await execFileAsync("claude", [
          "sessions", "list", "--limit", "1", "--json",
        ], {
          timeout: 10_000,
          env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
        });
        const sessions = JSON.parse(lsOut);
        if (sessions?.[0]?.id) {
          session.sessionId = sessions[0].id;
          console.log(`  [${chatKey}] Session (from list): ${session.sessionId?.slice(0, 8)}...`);
        }
      } catch {
        // Ignore — session tracking is best-effort
      }
    }

    const answer = stdout.trim();
    if (answer) {
      await reply(chatId, answer, threadId);
    } else {
      await reply(chatId, "❌ No response from Claude", threadId);
    }
  } catch (e: any) {
    console.error("Claude CLI error:", e.message);
    // If session error, reset and retry without resume
    if (session.sessionId && e.message?.includes("session")) {
      console.log(`  [${chatKey}] Session error, resetting...`);
      session.sessionId = null;
    }
    await reply(chatId, `❌ Error: ${e.message?.slice(0, 200)}`, threadId);
  }
}

// ============================================================
// MAIN LOOP
// ============================================================

async function main() {
  console.log("Bot listener started. Waiting for messages...");

  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);
        const threadId = msg.message_thread_id;
        const text = msg.text.trim();

        // Chat key includes thread for topic-based groups
        const chatKey = threadId ? `${chatId}:${threadId}` : chatId;

        // Extract reply context if user is replying to bot message
        let replyContext = "";
        if (msg.reply_to_message?.text) {
          replyContext = `[Đang reply message: "${msg.reply_to_message.text.slice(0, 300)}"] `;
        }

        const cleanText = text.replace(/@\w+/g, "").trim();
        const fullQuestion = replyContext + cleanText;

        if (cleanText === "/report" || cleanText.startsWith("/report")) {
          console.log(`[${chatKey}] /report command`);
          await handleReport(chatId, threadId);
        } else if (cleanText.length > 2) {
          console.log(`[${chatKey}] Question: ${cleanText.slice(0, 50)}`);
          await handleQuestion(chatId, fullQuestion, chatKey, threadId);
        }
      }
    } catch (e) {
      console.error("Poll error:", e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
