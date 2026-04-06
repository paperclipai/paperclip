// bot-listener.ts
// Long-polling Telegram bot with conversation memory
// /report triggers collectors, free text → Claude CLI with context

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import Database from "better-sqlite3";
import { execSync } from "child_process";

// ============================================================
// DATA SYNC
// ============================================================

import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYNC_DIR = process.env.METABASE_SYNC_DIR || join(__dirname, "../../metabase-sync");
const REPORTS_DIR = join(__dirname, "reports");

function isSyncedToday(): boolean {
  if (!WHALES_DB_PATH) return false;
  try {
    const db = new Database(WHALES_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT synced_at FROM _sync_log WHERE status = 'ok' ORDER BY synced_at DESC LIMIT 1`
    ).get() as { synced_at: string } | undefined;
    db.close();
    if (!row) return false;
    const syncDate = row.synced_at.slice(0, 10); // YYYY-MM-DD (UTC)
    const todayUTC = new Date().toISOString().slice(0, 10);
    return syncDate === todayUTC;
  } catch {
    return false;
  }
}

function syncData(): void {
  if (isSyncedToday()) {
    console.log("  Sync skipped (data already from today)");
    return;
  }
  try {
    console.log("  Syncing data...");
    execSync("node sync.mjs", { cwd: SYNC_DIR, timeout: 120_000, stdio: "pipe" });
    console.log("  Sync done ✓");
  } catch (e: any) {
    console.error("  Sync failed:", e.message?.slice(0, 100));
  }
}
import { sendTelegram, sendMessageWithKeyboard, sendDocument, answerCallbackQuery } from "./lib/telegram.js";
import { fetchPlatformMetrics } from "./lib/metabase-queries.js";
import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { moneySmart, growthBadge } from "./lib/formatters.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

// Run Claude CLI with prompt via stdin (avoids arg length limits)
function runClaude(
  args: string[],
  prompt: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout after ${timeout}ms`)); }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Exit code ${code}: ${stderr.slice(0, 300)}`));
      else resolve({ stdout, stderr });
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ============================================================
// FORMAT Claude output → Telegram-friendly text
// ============================================================

function formatForTelegram(raw: string): string {
  let text = raw;

  // Strip markdown code blocks — keep content only
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => code.trim());

  // Convert markdown bold **text** → <b>text</b>
  text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  // Convert markdown italic *text* or _text_ → <i>text</i>
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");

  // Convert markdown headers ## Title → TITLE (bold)
  text = text.replace(/^#{1,4}\s+(.+)$/gm, (_, title) => `<b>${title.toUpperCase()}</b>`);

  // Convert markdown bullet lists - item → item (clean)
  text = text.replace(/^[\s]*[-•]\s+/gm, "  ");

  // Convert numbered lists 1. item → 1) item
  text = text.replace(/^(\d+)\.\s+/gm, "$1) ");

  // Inline code `text` → text (just remove backticks)
  text = text.replace(/`([^`]+)`/g, "$1");

  // Clean up excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim
  text = text.trim();

  // Telegram message limit: 4096 chars
  if (text.length > 4000) {
    text = text.slice(0, 3950) + "\n\n<i>... (truncated)</i>";
  }

  return text;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const WHALES_DB_PATH = process.env.WHALES_DB_PATH;
const REPORT_MANAGER_ID = "07511795-8e84-4ff0-b7c2-cc5fdb8e4732";
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

// No longer needed — report filename embedded directly in callback_data

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
// HELP TEXT
// ============================================================

const HELP_TEXT = `<b>WHALES MARKET BOT</b>

<b>Commands</b>
/daily        —  Daily report
/weekly       —  Weekly report
/monthly      —  Monthly report
/token WLFI   —  Token analysis + visual report
/toptrader    —  Top traders (or /toptrader BP)
/reset        —  New conversation

<b>Ask anything</b>
Top tokens by volume 24h?
So sánh BP vs WET
Wallet 0xABC... trade gì?
Trend 14 ngày gần nhất

<i>Bot nhớ context — hỏi tiếp được.</i>`;

// ============================================================
// TELEGRAM
// ============================================================

async function getUpdates(): Promise<any[]> {
  const res = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.result ?? [];
}

async function reply(chatId: string, text: string, threadId?: number): Promise<string> {
  await sendTelegram(text, { botToken: BOT_TOKEN!, chatId, threadId });
  return text;
}

// ============================================================
// Unified report handler for /daily, /weekly, /monthly
// ============================================================

async function handlePeriodReport(chatId: string, period: "daily" | "weekly" | "monthly", threadId?: number) {
  await reply(chatId, `⏳ Generating ${period} report...`, threadId);
  syncData();

  if (!WHALES_DB_PATH) {
    await reply(chatId, "Database not configured", threadId);
    return;
  }

  try {
    const { buildReportData, formatReport } = await import("./lib/report-builder.js");
    const data = buildReportData(WHALES_DB_PATH, period);

    // Enrich with social (sync + query by period)
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
    const SOCIAL_ACCOUNTS = process.env.SOCIAL_ACCOUNTS;
    if (RAPIDAPI_KEY && SOCIAL_ACCOUNTS) {
      try {
        const { syncSocialData, getSocialReport, getSocialStructuredData } = await import("./lib/social-format.js");
        await syncSocialData(RAPIDAPI_KEY, JSON.parse(SOCIAL_ACCOUNTS));
        const html = getSocialReport(period);
        if (html) data.socialHtml = html;
        const structured = getSocialStructuredData(period);
        if (structured) data.socialData = structured;
      } catch {}
    }

    // Enrich with GA4 (query matching period)
    if (process.env.GA4_PROPERTY_ID) {
      try {
        const m = await fetchGA4Metrics(period);
        const premarketPages = m.topLandingPages
          .filter((p: any) => /^\/en\/premarket\//.test(p.page))
          .slice(0, 3);
        data.ga4 = {
          activeUsers: m.activeUsers,
          activeUsersPct: m.activeUsersPctChange,
          newUsers: m.newUsers,
          newUsersPct: m.newUsersPctChange,
          sessions: m.sessions,
          sessionsPct: m.sessionsPctChange,
          topPages: premarketPages.map((p: any) => ({
            token: p.page.replace("/en/premarket/", ""),
            sessions: p.sessions,
          })),
        };
      } catch {}
    }

    await reply(chatId, formatReport(data), threadId);

    // Buttons
    const periodKey = `${period}:${data.dateRange.replace(/\s/g, "")}`;
    await sendMessageWithKeyboard(
      `${data.label} · ${data.dateRange}`,
      [
        { text: "💡 AI Insight", callback_data: `periodinsight:${periodKey}` },
        { text: "📊 Visual Report", callback_data: `periodreport:${periodKey}` },
      ],
      { botToken: BOT_TOKEN!, chatId, threadId }
    );
  } catch (e: any) {
    await reply(chatId, `Error: ${e.message?.slice(0, 200)}`, threadId);
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

  await reply(chatId, "🤔 Syncing & thinking...", threadId);
  syncData();

  // ── Intent detection: pre-feed data for known patterns ──
  let prefeedData = "";
  const qLower = question.toLowerCase();

  if (WHALES_DB_PATH) {
    try {
      // Token analysis intent
      const tokenMatch = qLower.match(/(?:token|phân tích|analyze|analysis)\s+\$?([a-z]{2,10})/i)
        || qLower.match(/\$([a-z]{2,10})\b/i);
      if (tokenMatch) {
        const sym = tokenMatch[1].toUpperCase();
        const { analyzeToken } = await import("./lib/token-analysis.js");
        const a = analyzeToken(WHALES_DB_PATH, sym);
        if (a) {
          const askBid = a.askVolume + a.bidVolume;
          const fillRate = askBid > 0 ? (a.totalValueUsd / askBid * 100) : 0;
          prefeedData = `\n\n[PRE-COMPUTED DATA for $${sym}]
Volume: $${a.totalValueUsd.toFixed(0)} (${a.totalOrders} orders)
Fill Rate: ${fillRate.toFixed(1)}% (filled $${a.totalValueUsd.toFixed(0)} / web $${askBid.toFixed(0)})
Ask/Bid: Ask $${a.askVolume.toFixed(0)} (${(100 - a.bidSharePct).toFixed(0)}%) / Bid $${a.bidVolume.toFixed(0)} (${a.bidSharePct}%)
Settle: ${a.settleRate}% (${a.settledOrders}/${a.totalOrders}), cancelled ${a.cancelledOrders}
Users: ${a.newUsers + a.oldUsers} total (${a.newUserPct}% new, ${a.newUsers} new, ${a.oldUsers} old)
Whale: Top 5 = ${a.top5WhalePct}%
Fees: $${a.feesTotal.toFixed(0)}
Resale: ${a.resalePct}%
Weekly trend: ${a.weeklyTrend.map(w => `${w.week}=$${w.volume}`).join(", ")}
Peak days: ${a.peakDays.map(p => `${p.day}=$${p.volume}(${p.pctOfTotal}%)`).join(", ")}
Order buckets: ${a.orderBuckets.map(b => `${b.bucket}=${b.orders}ord/$${b.totalUsd}`).join(", ")}
Wallet tiers: ${a.walletTiers.map(t => `${t.tier}=${t.wallets}w/$${t.volume}`).join(", ")}
Top wallets: ${a.topWallets.slice(0, 5).map(w => `${w.address}=$${w.volume.toFixed(0)}(${w.role})`).join(", ")}
[Use this data. Do NOT re-query these metrics. Focus on INSIGHT and ANALYSIS.]`;
        }
      }

      // Top trader intent
      if (qLower.match(/top\s*trader|whale|trader|ví lớn|cá voi/)) {
        const tokenForTrader = qLower.match(/(?:top\s*trader|trader)\s+\$?([a-z]{2,10})/i);
        const { getTopTraders } = await import("./lib/top-traders.js");
        const traders = getTopTraders(WHALES_DB_PATH, { token: tokenForTrader?.[1]?.toUpperCase(), limit: 10 });
        if (traders.length > 0) {
          prefeedData += `\n\n[PRE-COMPUTED TOP TRADERS${tokenForTrader ? ` for $${tokenForTrader[1].toUpperCase()}` : ""}]
${traders.map((t, i) => `${i + 1}. ${t.shortAddr}: $${t.totalVolume.toFixed(0)} vol, ${t.totalOrders} orders, ${(t.buyerRatio * 100).toFixed(0)}% buyer, ${t.tokenDiversity} tokens, ${t.longestStreak}d streak, last ${t.recentDays}d ago, active ${t.activeDays}d`).join("\n")}
[Analyze these traders: patterns, red flags, notable behaviors. Do NOT re-query.]`;
        }
      }

      // Weekly/daily overview intent
      if (qLower.match(/tuần|week|weekly|hôm nay|today|daily|tháng|month/)) {
        const period = qLower.match(/tháng|month/) ? "monthly" : qLower.match(/tuần|week/) ? "weekly" : "daily";
        const { buildReportData } = await import("./lib/report-builder.js");
        const rd = buildReportData(WHALES_DB_PATH, period);
        const chg = (c: number, p: number) => p > 0 ? ((c - p) / p * 100).toFixed(1) + "%" : "N/A";
        prefeedData += `\n\n[PRE-COMPUTED ${period.toUpperCase()} DATA]
Filled Vol: $${rd.filledVolume.toFixed(0)} (prev: $${rd.prevFilledVolume.toFixed(0)}, change: ${chg(rd.filledVolume, rd.prevFilledVolume)})
Web Vol: $${rd.volumeOnWeb.toFixed(0)} (change: ${chg(rd.volumeOnWeb, rd.prevVolumeOnWeb)})
Orders: ${rd.totalOrders} (change: ${chg(rd.totalOrders, rd.prevTotalOrders)})
Users: ${rd.totalUsers} (${rd.newUsers} new, ${rd.oldUsers} old, change: ${chg(rd.totalUsers, rd.prevTotalUsers)})
Fees: $${rd.feesTotal.toFixed(0)}
Top tokens: ${rd.topTokens.slice(0, 5).map(t => `$${t.symbol}=$${t.volume}`).join(", ")}
[Use this data for your analysis. Do NOT re-query.]`;
      }
    } catch (e) {
      console.log("  Prefeed error:", (e as Error).message?.slice(0, 100));
    }
  }

  // Snapshot report files BEFORE Claude CLI call to detect new ones after
  const fsMod = await import("fs");
  const filesBefore = new Set(
    fsMod.existsSync(REPORTS_DIR)
      ? fsMod.readdirSync(REPORTS_DIR).filter((f: string) => f.endsWith(".md"))
      : []
  );
  const mtimesBefore = new Map<string, number>();
  for (const f of filesBefore) {
    try { mtimesBefore.set(f, fsMod.statSync(`${REPORTS_DIR}/${f}`).mtimeMs); } catch {}
  }

  const session = getSession(chatKey);
  const isNewSession = !session.sessionId;

  // Build prompt — system prompt only on first message, then just the question
  let prompt: string;
  if (isNewSession) {
    prompt = `ĐỌC 2 FILE:
1. ${SYNC_DIR}/SYSTEM_PROMPT.md — rules, schema, analysis framework
2. ${SYNC_DIR}/QUERY_PATTERNS.md — 13 verified SQL patterns (P1-P13), ALWAYS use these as base

Database: ${WHALES_DB_PATH}
Data dir: ${SYNC_DIR}
Reports dir: ${REPORTS_DIR}

IMPORTANT OUTPUT RULES:
- This response will be sent as a Telegram message.
- Do NOT use markdown code blocks (\`\`\`). Write SQL results as plain text.
- Use **bold** for key numbers. Do not use headers (#).
- Keep it under 300 words. Be direct — numbers first, then insight.
- Reply in Vietnamese. Metric names stay in English.

Question: "${question}"${prefeedData}`;
  } else {
    // Follow-up: just the question, Claude remembers context from session
    prompt = `${question}${prefeedData}`;
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

    const { stdout, stderr } = await runClaude(args, prompt, 1_800_000); // 30 minutes

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

    const answer = formatForTelegram(stdout);
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

        // Handle inline keyboard callbacks
        const callback = update.callback_query;
        if (callback?.data) {
          const cbChatId = String(callback.message?.chat?.id);
          const cbThreadId = callback.message?.message_thread_id;
          const [action, ...rest] = callback.data.split(":");
          const reportRef = rest.join(":"); // filename or legacy chatKey

          await answerCallbackQuery(callback.id, "⏳ Đang xử lý...", { botToken: BOT_TOKEN! });

          // Resolve report path from callback_data
          // New format: action:{filename} (e.g. chart:2026-04-02-top-tokens)
          // Legacy format: action:{chatKey} — fallback to latest file
          let reportPath: string | undefined;
          const fs = await import("fs");
          const candidatePath = `${REPORTS_DIR}/${reportRef}.md`;
          if (fs.existsSync(candidatePath)) {
            reportPath = candidatePath;
          } else {
            // Legacy fallback: find latest report file
            try {
              const files = fs.readdirSync(REPORTS_DIR)
                .filter((f: string) => f.endsWith(".md") && f !== ".gitkeep")
                .sort()
                .reverse();
              if (files.length > 0) reportPath = `${REPORTS_DIR}/${files[0]}`;
            } catch {}
          }
          if (!reportPath) {
            await reply(cbChatId, "❌ Không tìm thấy file report. Hỏi lại để generate.", cbThreadId);
            continue;
          }

          if (action === "periodreport") {
            const [period] = reportRef.split(":") as ["daily" | "weekly" | "monthly"];
            await reply(cbChatId, `⏳ Generating ${period} visual report...`, cbThreadId);
            try {
              const { buildReportData } = await import("./lib/report-builder.js");
              const { generatePeriodReportHtml } = await import("./lib/period-report-html.js");
              const data = buildReportData(WHALES_DB_PATH!, period);
              // Enrich with social
              try {
                const { getSocialStructuredData } = await import("./lib/social-format.js");
                const sd = getSocialStructuredData(period);
                if (sd) data.socialData = sd;
              } catch {}
              // Enrich with GA4
              if (process.env.GA4_PROPERTY_ID) {
                try {
                  const m = await fetchGA4Metrics(period);
                  const pages = m.topLandingPages?.filter((p: any) => /^\/en\/premarket\//.test(p.page)).slice(0, 5) || [];
                  data.ga4 = {
                    activeUsers: m.activeUsers, activeUsersPct: m.activeUsersPctChange,
                    newUsers: m.newUsers, newUsersPct: m.newUsersPctChange,
                    sessions: m.sessions, sessionsPct: m.sessionsPctChange,
                    topPages: pages.map((p: any) => ({ token: p.page.replace("/en/premarket/", ""), sessions: p.sessions })),
                  };
                } catch {}
              }
              const fs = await import("fs");
              if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
              const htmlPath = generatePeriodReportHtml(data, REPORTS_DIR);
              await sendDocument(htmlPath, `📊 ${period.charAt(0).toUpperCase() + period.slice(1)} Report`, {
                botToken: BOT_TOKEN!, chatId: cbChatId, threadId: cbThreadId,
              });
            } catch (e: any) {
              await reply(cbChatId, `Error: ${e.message?.slice(0, 200)}`, cbThreadId);
            }
            continue;
          }

          if (action === "periodinsight") {
            const [period] = reportRef.split(":") as ["daily" | "weekly" | "monthly"];
            await reply(cbChatId, `💡 Analyzing ${period}...`, cbThreadId);
            try {
              const { buildReportData } = await import("./lib/report-builder.js");
              const d = buildReportData(WHALES_DB_PATH!, period);
              const chatKey = cbThreadId ? `${cbChatId}:${cbThreadId}` : cbChatId;
              // Reset session for fresh context
              const session = getSession(chatKey);
              session.sessionId = null;
              session.lastActivity = 0;
              const pctChg = (c: number, p: number) => p > 0 ? ((c - p) / p * 100).toFixed(1) + "%" : "N/A";
              const prompt = `ĐỌC FILE ${SYNC_DIR}/SYSTEM_PROMPT.md trước để hiểu business context.

${period.toUpperCase()} performance (${d.dateRange}):
- Filled Volume: $${d.filledVolume.toFixed(0)} (prev: $${d.prevFilledVolume.toFixed(0)}, change: ${pctChg(d.filledVolume, d.prevFilledVolume)})
- Web Volume: $${d.volumeOnWeb.toFixed(0)} (change: ${pctChg(d.volumeOnWeb, d.prevVolumeOnWeb)})
- Orders: ${d.totalOrders} (change: ${pctChg(d.totalOrders, d.prevTotalOrders)})
- Users: ${d.totalUsers} (${d.newUsers} new, ${d.oldUsers} old, change: ${pctChg(d.totalUsers, d.prevTotalUsers)})
- Top tokens: ${d.topTokens.slice(0, 5).map(t => `$${t.symbol} $${t.volume}`).join(", ")}
- Fees: $${d.feesTotal.toFixed(0)}

Đưa ra 3-5 insights cho team. Focus: trend so với kỳ trước, risk signals, token highlights, user quality. Platform operator perspective. Mỗi insight 1-2 câu.`;
              await handleQuestion(cbChatId, prompt, chatKey, cbThreadId);
            } catch (e: any) {
              await reply(cbChatId, `Error: ${e.message?.slice(0, 200)}`, cbThreadId);
            }
            continue;
          }

          if (action === "tokeninsight") {
            const sym = reportRef;
            await reply(cbChatId, `💡 Deep analysis $${sym}...`, cbThreadId);
            try {
              const { runForensic } = await import("./lib/trader-forensic.js");
              const r = runForensic(WHALES_DB_PATH!, sym);
              if (!r) {
                await reply(cbChatId, `Token $${sym} not found`, cbThreadId);
              } else {
                const chatKey = cbThreadId ? `${cbChatId}:${cbThreadId}` : cbChatId;
                const typeIcon: Record<string, string> = { "Market Maker": "🔵", Accumulator: "🟢", Dumper: "🔴", Flipper: "🟡" };
                // Reset session so Claude reads SYSTEM_PROMPT fresh
                const session = getSession(chatKey);
                session.sessionId = null;
                session.lastActivity = 0;

                const prompt = `Bạn là data analyst chuyên sâu. ĐỌC FILE ${SYNC_DIR}/SYSTEM_PROMPT.md trước để hiểu business context (đặc biệt phần Settlement mechanics và Whale classification).

Phân tích token $${sym} theo 8 modules dưới đây. Mỗi module viết 2-3 câu insight cụ thể, có số liệu. Cuối cùng đưa kết luận tổng thể.

DATA ĐÃ TÍNH SẴN (không cần query lại):

1. CONCENTRATION
Top 10 wallets: ${r.top10Pct}% volume · Top 20: ${r.top20Pct}% · Top 50: ${r.top50Pct}%
Ngưỡng: >50% = cao, >70% = cực kỳ nguy hiểm
→ ${r.concentrationLevel}

2. WALLET CLASSIFICATION (top wallets >$1K volume)
🔴 Dumper (>90% sell): ${r.classification.dumpers} ví, ${moneySmart(r.classification.dumperVol)}
🟢 Accumulator (>70% buy): ${r.classification.accumulators} ví, ${moneySmart(r.classification.accumulatorVol)}
🔵 Market Maker (balanced + >50 orders): ${r.classification.marketMakers} ví, ${moneySmart(r.classification.mmVol)}
🟡 Flipper (resale >30%): ${r.classification.flippers} ví, ${moneySmart(r.classification.flipperVol)}
Xu hướng chủ đạo: ${r.dominantBehavior}

3. SPECULATION
Resale rate: ${r.resalePct}% (benchmark: 10% bình thường, >25% bất thường, >30% cờ đỏ)
Ví có resale >50%: ${r.highResaleWallets} ví
→ ${r.resaleLevel}

4. USER QUALITY
New user (chỉ trade token này): ${r.newUserPct}%
Ngưỡng: >70% = đáng ngờ (pump scheme), <50% = organic
→ ${r.userQuality}

5. ORDER SIZE
Whale >$20K: ${r.whaleVolPct}% volume · Mid $1K-20K: ${r.midVolPct}% · Retail <$1K: ${r.retailVolPct}%
Ngưỡng: whale >60% = không dành cho retail, retail <15% = không có nền tảng user thực
→ ${r.retailLevel}

6. TEMPORAL PATTERN
Avg daily: ${moneySmart(r.avgDailyVol)} · Peak: ${moneySmart(r.maxDailyVol)} (${r.spikeRatio}x avg)
Peak days: ${r.peakDays.map(p => `${p.day}: ${moneySmart(p.vol)} (${p.pct}%)`).join(", ")}
Spike ratio >10x = coordinated pump, <5x = organic
→ ${r.isOrganic ? "Organic" : "Spike-driven"}

7. RED FLAGS
${r.redFlags.length > 0 ? r.redFlags.map(f => `⚠️ ${f}`).join("\n") : "Không có red flag"}

8. TOP 5 WALLETS
${r.topWallets.slice(0, 5).map((w, i) => `${i + 1}. ${w.address} [${w.type}]: ${moneySmart(w.vol)}, ${w.orders} orders, Buy ${w.buyPct}%, Resale ${w.resalePct}%`).join("\n")}

TỔNG: $${r.totalVolume.toFixed(0)} vol · ${r.totalOrders} orders · ${r.totalWallets} wallets
Risk Score: ${r.riskScore}/100 (${r.riskLevel})

YÊU CẦU OUTPUT:
- Viết tiếng Việt, metric giữ English
- Mỗi module: tiêu đề + 2-3 câu insight có SỐ LIỆU cụ thể
- Cuối cùng: KẾT LUẬN TỔNG THỂ (risk level + khuyến nghị cho platform)
- Nhớ context settle rate: low settle = seller forfeit collateral vì token moon = BULLISH, không phải risk
- Phân biệt market maker vs dumper — MM cung cấp liquidity = tốt
- Tổng 400-500 words`;
                await handleQuestion(cbChatId, prompt, chatKey, cbThreadId);
              }
            } catch (e: any) {
              await reply(cbChatId, `Error: ${e.message?.slice(0, 200)}`, cbThreadId);
            }
            continue;
          }

          if (action === "tokenreport") {
            const sym = reportRef;
            await reply(cbChatId, `⏳ Generating report for $${sym}...`, cbThreadId);
            try {
              const { analyzeToken } = await import("./lib/token-analysis.js");
              const { generateTokenReportHtml } = await import("./lib/token-report-html.js");
              const analysis = analyzeToken(WHALES_DB_PATH!, sym);
              if (!analysis) {
                await reply(cbChatId, `Token $${sym} not found`, cbThreadId);
              } else {
                const fs = await import("fs");
                if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
                const htmlPath = generateTokenReportHtml(analysis, REPORTS_DIR);
                await sendDocument(htmlPath, `📊 $${sym} Token Report`, {
                  botToken: BOT_TOKEN!, chatId: cbChatId, threadId: cbThreadId,
                });
              }
            } catch (e: any) {
              await reply(cbChatId, `Error: ${e.message?.slice(0, 200)}`, cbThreadId);
            }
            continue;
          }

          if (action === "detail") {
            try {
              await sendDocument(reportPath, "📄 Phân tích chi tiết", {
                botToken: BOT_TOKEN!, chatId: cbChatId, threadId: cbThreadId
              });
            } catch (e: any) {
              await reply(cbChatId, `❌ Gửi file thất bại: ${e.message?.slice(0, 100)}`, cbThreadId);
            }
          } else if (action === "chart") {
            await reply(cbChatId, "⏳ Generating chart...", cbThreadId);
            try {
              const { generateContextHtml } = await import("./lib/context-chart.js");
              const htmlPath = await generateContextHtml(reportPath, WHALES_DB_PATH!);
              await sendDocument(htmlPath, "📊 Interactive Report", {
                botToken: BOT_TOKEN!, chatId: cbChatId, threadId: cbThreadId
              });
            } catch (e: any) {
              await reply(cbChatId, `❌ Chart failed: ${e.message?.slice(0, 100)}`, cbThreadId);
            }
          }
          continue;
        }

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

        if (cleanText === "/help" || cleanText === "/start") {
          await reply(chatId, HELP_TEXT, threadId);
        } else if (cleanText === "/daily" || cleanText.startsWith("/daily")) {
          console.log(`[${chatKey}] /daily`);
          await handlePeriodReport(chatId, "daily", threadId);
        } else if (cleanText === "/weekly" || cleanText.startsWith("/weekly")) {
          console.log(`[${chatKey}] /weekly`);
          await handlePeriodReport(chatId, "weekly", threadId);
        } else if (cleanText === "/monthly" || cleanText.startsWith("/monthly")) {
          console.log(`[${chatKey}] /monthly`);
          await handlePeriodReport(chatId, "monthly", threadId);
        } else if (cleanText.startsWith("/toptrader")) {
          const arg = cleanText.replace("/toptrader", "").trim().toUpperCase();
          console.log(`[${chatKey}] /toptrader ${arg || "all"}`);
          if (!WHALES_DB_PATH) { await reply(chatId, "Database not configured", threadId); }
          else if (!arg) {
            // No token specified — show basic top traders list
            syncData();
            try {
              const { getTopTraders, formatTopTraders } = await import("./lib/top-traders.js");
              const traders = getTopTraders(WHALES_DB_PATH, { limit: 10 });
              await reply(chatId, formatTopTraders(traders), threadId);
            } catch (e: any) {
              await reply(chatId, `Error: ${e.message?.slice(0, 200)}`, threadId);
            }
          } else {
            // Token specified — run full forensic analysis
            syncData();
            try {
              const { runForensic, formatForensic } = await import("./lib/trader-forensic.js");
              const report = runForensic(WHALES_DB_PATH, arg);
              if (!report) {
                await reply(chatId, `Token $${arg} not found`, threadId);
              } else {
                await reply(chatId, formatForensic(report), threadId);
                await sendMessageWithKeyboard(
                  `$${arg} Forensic`,
                  [
                    { text: "💡 AI Insight", callback_data: `tokeninsight:${arg}` },
                    { text: "📊 Visual Report", callback_data: `tokenreport:${arg}` },
                  ],
                  { botToken: BOT_TOKEN!, chatId, threadId }
                );
              }
            } catch (e: any) {
              await reply(chatId, `Error: ${e.message?.slice(0, 200)}`, threadId);
            }
          }
        } else if (cleanText.startsWith("/token")) {
          const symbol = cleanText.replace("/token", "").trim().toUpperCase();
          if (!symbol) {
            await reply(chatId, "Usage: /token WLFI", threadId);
          } else if (!WHALES_DB_PATH) {
            await reply(chatId, "Database not configured", threadId);
          } else {
            console.log(`[${chatKey}] /token ${symbol}`);
            syncData();
            try {
              const { analyzeToken, formatTokenSummary } = await import("./lib/token-analysis.js");
              const analysis = analyzeToken(WHALES_DB_PATH, symbol);
              if (!analysis) {
                await reply(chatId, `Token $${symbol} not found`, threadId);
              } else {
                await reply(chatId, formatTokenSummary(analysis), threadId);
                await sendMessageWithKeyboard(
                  `$${symbol}`,
                  [
                    { text: "💡 AI Insight", callback_data: `tokeninsight:${symbol}` },
                    { text: "📊 Visual Report", callback_data: `tokenreport:${symbol}` },
                  ],
                  { botToken: BOT_TOKEN!, chatId, threadId }
                );
              }
            } catch (e: any) {
              await reply(chatId, `Error: ${e.message?.slice(0, 200)}`, threadId);
            }
          }
        } else if (cleanText.startsWith("/reset")) {
          const session = getSession(chatKey);
          session.sessionId = null;
          session.lastActivity = 0;
          await reply(chatId, "🔄 Session reset. Conversation mới.", threadId);
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
