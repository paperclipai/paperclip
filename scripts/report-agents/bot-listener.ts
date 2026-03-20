// bot-listener.ts
// Long-polling Telegram bot: /report triggers collectors, free text → LLM + DB query
// Env: TELEGRAM_BOT_TOKEN, WHALES_DB_PATH, ANTHROPIC_API_KEY, GA4_PROPERTY_ID, RAPIDAPI_KEY, SOCIAL_ACCOUNTS

import Database from "better-sqlite3";
import { sendTelegram } from "./lib/telegram.js";
import { fetchPlatformMetrics } from "./lib/metabase-queries.js";
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const WHALES_DB_PATH = process.env.WHALES_DB_PATH;
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

const TELEGRAM_API = "https://api.telegram.org";
let offset = 0;

// --- Telegram long polling ---
async function getUpdates(): Promise<any[]> {
  const res = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.result ?? [];
}

async function reply(chatId: string, text: string, threadId?: number) {
  await sendTelegram(text, { botToken: BOT_TOKEN!, chatId, threadId });
}

// --- /report command ---
async function handleReport(chatId: string, threadId?: number) {
  await reply(chatId, "⏳ Generating reports...", threadId);

  // Platform
  if (WHALES_DB_PATH) {
    try {
      // Import buildHtml logic inline
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

  // Social
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const SOCIAL_ACCOUNTS = process.env.SOCIAL_ACCOUNTS;
  if (RAPIDAPI_KEY && SOCIAL_ACCOUNTS) {
    try {
      // Dynamic import to avoid circular deps
      const { runSocialCollector } = await import("./lib/social-format.js");
      const html = await runSocialCollector(RAPIDAPI_KEY, JSON.parse(SOCIAL_ACCOUNTS));
      if (html) await reply(chatId, html, threadId);
      else await reply(chatId, "📱 Social: No tweets from yesterday", threadId);
    } catch (e) {
      await reply(chatId, `📱 Social error: ${e}`, threadId);
    }
  }

  // GA
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

// --- Free text Q&A via Claude CLI ---
async function handleQuestion(chatId: string, question: string, threadId?: number) {
  if (!WHALES_DB_PATH) {
    await reply(chatId, "❌ Q&A requires WHALES_DB_PATH", threadId);
    return;
  }

  await reply(chatId, "🤔 Thinking...", threadId);

  const prompt = `Bạn là Data Analyst cho Whales Market. Bạn trả lời câu hỏi từ internal team dựa trên dữ liệu thực.

ĐỌC CÁC FILE NÀY TRƯỚC KHI LÀM GÌ:
1. /Users/amando/Desktop/Learn/metabase-sync/BUSINESS_CONTEXT.md — business context, KPIs, benchmarks, cách trả lời
2. /Users/amando/Desktop/Learn/metabase-sync/SCHEMA.md — database schema
3. /Users/amando/Desktop/Learn/metabase-sync/QUERY_PATTERNS.md — verified query patterns, BẮT BUỘC dùng

Database SQLite tại: ${WHALES_DB_PATH}

Câu hỏi từ team: "${question}"

CÁCH TRẢ LỜI:
1. Query database dùng verified patterns (KHÔNG tự viết SQL)
2. So sánh kết quả với benchmarks trong BUSINESS_CONTEXT.md
3. Phân biệt rõ: <b>Fact</b> (số liệu) → <b>Observation</b> (pattern) → <b>Recommendation</b> (đề xuất)
4. Viết tiếng Việt, giữ metric tiếng Anh
5. Format HTML cho Telegram (<b>, <i>), dưới 800 ký tự
6. KHÔNG dùng markdown, code blocks, backticks`;

  try {
    const { stdout } = await execFileAsync("claude", [
      "--print",
      "--dangerously-skip-permissions",
      "--model", "claude-sonnet-4-5-20250929",
      "-p", prompt,
    ], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    });

    const answer = stdout.trim();
    if (answer) {
      await reply(chatId, answer, threadId);
    } else {
      await reply(chatId, "❌ No response from Claude", threadId);
    }
  } catch (e: any) {
    console.error("Claude CLI error:", e.message);
    await reply(chatId, `❌ Error: ${e.message?.slice(0, 200)}`, threadId);
  }
}

// --- Main loop ---
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

        // Skip if bot mentioned in group but no real content
        const cleanText = text.replace(/@\w+/g, "").trim();

        if (cleanText === "/report" || cleanText.startsWith("/report")) {
          console.log(`[${chatId}] /report command`);
          await handleReport(chatId, threadId);
        } else if (cleanText.length > 2) {
          console.log(`[${chatId}] Question: ${cleanText.slice(0, 50)}`);
          await handleQuestion(chatId, cleanText, threadId);
        }
      }
    } catch (e) {
      console.error("Poll error:", e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
