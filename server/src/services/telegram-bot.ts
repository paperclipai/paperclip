import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, issues, issueComments } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import type { WatchdogHealthSnapshot } from "./watchdog.js";
import {
  createTelegramGateway,
  parseTelegramGatewayConfigFromEnv,
  buildTelegramCEOReport,
} from "./telegram-gateway.js";

const API = (token: string) => `https://api.telegram.org/bot${token}`;

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusIcon(status: string): string {
  const map: Record<string, string> = {
    idle: "🟢", running: "🔵", paused: "⏸", error: "🔴", queued: "🟡",
  };
  return map[status] ?? "⚪";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function truncate(text: string, max = 3000): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function readCostUsd(json: Record<string, unknown> | null | undefined): number {
  if (!json) return 0;
  for (const key of ["total_cost_usd", "costUsd", "cost_usd"] as const) {
    const v = json[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function inlineKeyboardMarkup(rows: Array<Array<{ text: string; callback_data: string }>>): Record<string, unknown> {
  return { inline_keyboard: rows };
}

// ── Telegram API ──────────────────────────────────────────────────────────────

async function tgFetch(token: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API(token)}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json() as { ok: boolean; result?: unknown };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

export async function sendTelegramMessage(token: string, chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
  await tgFetch(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function sendTyping(token: string, chatId: string): void {
  void tgFetch(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
}

// ── Agent alias resolution ────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
  return dp[m]![n]!;
}

type AgentRow = { id: string; name: string | null; role: string | null; status: string };

async function findAgentByAlias(
  db: Db,
  companyId: string,
  alias: string,
): Promise<{ agent: AgentRow | null; suggestions: AgentRow[] }> {
  const all = await db
    .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const norm = alias.toLowerCase().trim();

  // Priority match
  const exact = all.filter((a) => a.name?.toLowerCase() === norm || a.role?.toLowerCase() === norm);
  if (exact.length === 1) return { agent: exact[0]!, suggestions: [] };
  if (exact.length > 1) return { agent: null, suggestions: exact };

  const starts = all.filter((a) => a.name?.toLowerCase().startsWith(norm) || a.role?.toLowerCase().startsWith(norm));
  if (starts.length === 1) return { agent: starts[0]!, suggestions: [] };
  if (starts.length > 1) return { agent: null, suggestions: starts };

  const includes = all.filter((a) => a.name?.toLowerCase().includes(norm) || a.role?.toLowerCase().includes(norm));
  if (includes.length === 1) return { agent: includes[0]!, suggestions: [] };
  if (includes.length > 1) return { agent: null, suggestions: includes };

  const prefixId = all.filter((a) => a.id.startsWith(norm));
  if (prefixId.length === 1) return { agent: prefixId[0]!, suggestions: [] };

  // Suggest by Levenshtein
  const suggestions = all
    .map((a) => ({ a, dist: Math.min(levenshtein(norm, a.name?.toLowerCase() ?? ""), levenshtein(norm, a.role?.toLowerCase() ?? "")) }))
    .sort((x, y) => x.dist - y.dist)
    .slice(0, 3)
    .map((x) => x.a);

  return { agent: null, suggestions };
}

// ── Company resolution ────────────────────────────────────────────────────────

let _cachedCompanyId: string | null = null;
async function resolveCompanyId(db: Db, hint?: string): Promise<string | null> {
  if (hint) return hint;
  if (_cachedCompanyId) return _cachedCompanyId;
  const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
  _cachedCompanyId = first?.id ?? null;
  return _cachedCompanyId;
}

// ── Reply builders ────────────────────────────────────────────────────────────

async function buildAgentsReply(db: Db, companyId: string): Promise<{ text: string; replyMarkup?: unknown }> {
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const allAgents = await db
    .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const todayRuns = await db
    .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(gte(heartbeatRuns.createdAt, todayStart));

  const lastRuns = await db
    .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.agentId, allAgents.map((a) => a.id)))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(allAgents.length * 3);

  const openIssueCounts = await db
    .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"])))
    .groupBy(issues.assigneeAgentId);

  const openByAgent = new Map(openIssueCounts.map((r) => [r.agentId, r.count]));

  const runsByAgent = new Map<string, { ok: number; fail: number; costUsd: number }>();
  for (const r of todayRuns) {
    const cur = runsByAgent.get(r.agentId) ?? { ok: 0, fail: 0, costUsd: 0 };
    if (r.status === "succeeded") cur.ok++;
    else if (r.status === "failed") cur.fail++;
    cur.costUsd += readCostUsd(r.usageJson as Record<string, unknown> | null);
    runsByAgent.set(r.agentId, cur);
  }

  const lastByAgent = new Map<string, typeof lastRuns[0]>();
  for (const r of lastRuns) {
    if (!lastByAgent.has(r.agentId)) lastByAgent.set(r.agentId, r);
  }

  const lines: string[] = [`<b>Agents</b> — ${now.toTimeString().slice(0, 5)}\n━━━━━━━━━━━━━━━━━━━━━━━━`];
  const resumeButtons: Array<{ text: string; callback_data: string }> = [];

  for (const agent of allAgents) {
    const label = agent.name ?? agent.role ?? agent.id.slice(0, 8);
    const runs = runsByAgent.get(agent.id);
    const last = lastByAgent.get(agent.id);
    const openCount = openByAgent.get(agent.id) ?? 0;

    let card = `\n${statusIcon(agent.status)} <b>${label}</b> · ${agent.status}`;

    if (agent.status === "running" && last?.startedAt) {
      card += ` (started ${timeAgo(last.startedAt)})`;
    }

    if (last && agent.status !== "running") {
      const dur = last.startedAt && last.finishedAt ? formatDuration(last.finishedAt.getTime() - last.startedAt.getTime()) : "?";
      card += `\n  ↳ Last: ${last.status === "succeeded" ? "✓" : "✗"} ${dur} · ${timeAgo(last.createdAt)}`;
    }

    if (runs) {
      card += `\n  ↳ Today: ${runs.ok + runs.fail} runs · ${runs.ok}✓ ${runs.fail}✗ · $${runs.costUsd.toFixed(3)}`;
    }

    if (openCount > 0) card += `\n  ↳ Open issues: ${openCount}`;

    if (agent.status === "paused") {
      if (agent.pauseReason) card += `\n  ↳ Reason: ${agent.pauseReason}`;
      if (agent.pausedAt) card += ` · ${timeAgo(agent.pausedAt)}`;
      resumeButtons.push({ text: `▶ Resume ${label}`, callback_data: `resume:${agent.id}` });
    }

    lines.push(card);
  }

  const replyMarkup = resumeButtons.length > 0 ? inlineKeyboardMarkup([resumeButtons]) : undefined;
  return { text: truncate(lines.join("\n")), replyMarkup };
}

async function buildHealthReply(snapshot: WatchdogHealthSnapshot): Promise<string> {
  const statusEmoji = { ok: "🟢", warn: "🟡", error: "🔴" } as const;
  const lines = [`<b>Watchdog Health</b> — ${snapshot.generatedAt.toTimeString().slice(0, 5)}\n━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const item of snapshot.items) {
    lines.push(`${statusEmoji[item.status]} <b>${item.check}</b>: ${item.detail}`);
  }
  return lines.join("\n");
}

async function buildRunsReply(db: Db, agentLabel: string, agentId: string, limit: number): Promise<string> {
  const runs = await db
    .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt, stderrExcerpt: heartbeatRuns.stderrExcerpt })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, agentId))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);

  if (runs.length === 0) return `<b>Runs — ${agentLabel}</b>\nNo runs found.`;

  const lines = [`<b>Runs — ${agentLabel}</b> (last ${runs.length})\n━━━━━━━━━━━━━━━━━━━`];
  for (const r of runs) {
    const dur = r.startedAt && r.finishedAt ? formatDuration(r.finishedAt.getTime() - r.startedAt.getTime()) : "?";
    const icon = r.status === "succeeded" ? "✅" : r.status === "failed" ? "❌" : "🟡";
    let line = `${icon} ${r.status} · ${dur} · ${timeAgo(r.createdAt)}`;
    if (r.status === "failed" && r.stderrExcerpt) {
      const excerpt = r.stderrExcerpt.split("\n").pop()?.trim() ?? "";
      if (excerpt) line += `\n   <i>${excerpt.slice(0, 80)}</i>`;
    }
    lines.push(line);
  }
  return truncate(lines.join("\n"));
}

async function buildCostReply(db: Db, companyId: string): Promise<string> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const lookback = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const allAgents = await db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const todayRuns = await db
    .select({ agentId: heartbeatRuns.agentId, usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(and(gte(heartbeatRuns.createdAt, todayStart), inArray(heartbeatRuns.agentId, allAgents.map((a) => a.id))));

  const todayByAgent = new Map<string, { costUsd: number; count: number }>();
  for (const r of todayRuns) {
    const cur = todayByAgent.get(r.agentId) ?? { costUsd: 0, count: 0 };
    cur.costUsd += readCostUsd(r.usageJson as Record<string, unknown> | null);
    cur.count++;
    todayByAgent.set(r.agentId, cur);
  }

  const historicRuns = await db
    .select({ agentId: heartbeatRuns.agentId, usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(and(gte(heartbeatRuns.createdAt, lookback), eq(heartbeatRuns.status, "succeeded"), inArray(heartbeatRuns.agentId, allAgents.map((a) => a.id))));

  const avgByAgent = new Map<string, number>();
  const histGrouped = new Map<string, number[]>();
  for (const r of historicRuns) {
    const cost = readCostUsd(r.usageJson as Record<string, unknown> | null);
    if (cost > 0) {
      const arr = histGrouped.get(r.agentId) ?? [];
      arr.push(cost);
      histGrouped.set(r.agentId, arr);
    }
  }
  for (const [agentId, costs] of histGrouped) {
    if (costs.length >= 3) avgByAgent.set(agentId, costs.reduce((a, b) => a + b, 0) / costs.length);
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [`<b>Cost Today</b> — ${today}\n━━━━━━━━━━━━━━━━━━━━`];
  let totalCost = 0;
  let totalRuns = 0;
  const warnings: string[] = [];

  for (const agent of allAgents) {
    const label = agent.name ?? agent.role ?? agent.id.slice(0, 8);
    const data = todayByAgent.get(agent.id) ?? { costUsd: 0, count: 0 };
    totalCost += data.costUsd;
    totalRuns += data.count;
    const costStr = `$${data.costUsd.toFixed(3)}`.padEnd(8);
    const runStr = String(data.count).padStart(3) + " runs";
    lines.push(`${label.padEnd(10)} ${costStr}  ${runStr}`);

    const avg = avgByAgent.get(agent.id);
    if (avg && data.count > 0) {
      const perRun = data.costUsd / data.count;
      if (perRun > avg * 2) {
        const pct = Math.round((perRun / avg - 1) * 100);
        warnings.push(`⚠️ ${label}: +${pct}% vs 7-day avg ($${perRun.toFixed(4)}/run vs $${avg.toFixed(4)})`);
      }
    }
  }

  lines.push(`─────────────────────`);
  lines.push(`${"Total".padEnd(10)} $${totalCost.toFixed(3).padEnd(7)}  ${String(totalRuns).padStart(3)} runs`);
  if (warnings.length > 0) { lines.push(""); lines.push(...warnings); }
  return truncate(lines.join("\n"));
}

async function buildLogsReply(db: Db, agentLabel: string, agentId: string): Promise<string> {
  const run = await db
    .select({ stdoutExcerpt: heartbeatRuns.stdoutExcerpt, stderrExcerpt: heartbeatRuns.stderrExcerpt, status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, agentId))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!run) return `<b>Logs — ${agentLabel}</b>\nNo runs found.`;

  const parts: string[] = [`<b>Logs — ${agentLabel}</b> · ${run.status} · ${timeAgo(run.createdAt)}\n━━━━━━━━━━━━━━━━━━━`];
  if (run.stdoutExcerpt) parts.push(`<b>stdout:</b>\n<code>${run.stdoutExcerpt.slice(-600)}</code>`);
  if (run.stderrExcerpt) parts.push(`<b>stderr:</b>\n<code>${run.stderrExcerpt.slice(-400)}</code>`);
  if (!run.stdoutExcerpt && !run.stderrExcerpt) parts.push("No output captured.");
  return truncate(parts.join("\n\n"));
}

async function buildIssuesReply(db: Db, companyId: string, agentFilter?: AgentRow): Promise<string> {
  const where = agentFilter
    ? and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentFilter.id), inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]))
    : and(eq(issues.companyId, companyId), inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]));

  const rows = await db
    .select({ id: issues.id, title: issues.title, status: issues.status, assigneeAgentId: issues.assigneeAgentId, createdAt: issues.createdAt })
    .from(issues)
    .where(where)
    .orderBy(desc(issues.createdAt))
    .limit(10);

  const header = agentFilter
    ? `<b>Issues — ${agentFilter.name ?? agentFilter.role}</b>`
    : `<b>Open Issues</b>`;

  if (rows.length === 0) return `${header}\nNo open issues.`;

  const allAgentIds = [...new Set(rows.map((r) => r.assigneeAgentId).filter(Boolean) as string[])];
  const agentNames = allAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents).where(inArray(agents.id, allAgentIds))
    : [];
  const agentMap = new Map(agentNames.map((a) => [a.id, a.name ?? a.role ?? "?"]));

  const statusIcon2 = (s: string) => ({ todo: "📋", in_progress: "🔧", in_review: "👀", blocked: "🔴" })[s] ?? "⚪";
  const lines = [`${header} (${rows.length})\n━━━━━━━━━━━━━━━━━━━`];
  for (const r of rows) {
    const assignee = r.assigneeAgentId ? agentMap.get(r.assigneeAgentId) ?? "?" : "unassigned";
    lines.push(`${statusIcon2(r.status)} <b>${r.title.slice(0, 60)}</b>\n   ${assignee} · ${timeAgo(r.createdAt)} · <code>${r.id.slice(0, 8)}</code>`);
  }
  return truncate(lines.join("\n"));
}

function buildHelpReply(): string {
  return `<b>Paperclip Agent Control</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>Control agenți</b>
/ask &lt;agent&gt; &lt;task&gt;  — trimite task, primești răspuns
/run &lt;agent&gt;          — trezește agent (fără task nou)
/stop [agent]         — pauze agent sau toți
/resume [agent]       — repornire agent

<b>Monitoring</b>
/agents               — status live toți agenții
/health               — watchdog snapshot (5 checks)
/runs [agent] [n]     — ultimele N runs (default 5)
/cost                 — cost azi per agent
/logs [agent]         — output ultimul run

<b>Issues</b>
/issues [agent]       — open issues
/cancel &lt;id&gt;          — anulează issue (primele 8 chars)
/bet m|mkt|sel|odds|stake — pariu rapid via BBA

<b>Sistem</b>
/status               — overview sistem
/today                — activitate azi
/approve &lt;id&gt;         — aprobare comandă
/reject &lt;id&gt;          — respingere
/help                 — această listă

<b>Exemple</b>
/ask cto Analizează performanța BBA
/run bba
/stop cto
/resume bba
/runs bba 10
/cost
/logs bba
/issues cto
/bet Bayern PSG|BTTS|Da|1.24|30
/cancel abc12345`;
}

async function buildTodayReply(db: Db): Promise<string> {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const runs = await db
    .select({ status: heartbeatRuns.status, usageJson: heartbeatRuns.usageJson, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(gte(heartbeatRuns.createdAt, since));

  const total = runs.length;
  const completed = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const costUsd = runs.reduce((sum, r) => sum + readCostUsd(r.usageJson as Record<string, unknown> | null), 0);

  return buildTelegramCEOReport({
    headline: "<b>Today's Activity</b>",
    summary: `Runs: ${total} total · ${completed} succeeded · ${failed} failed`,
    highlights: [`Cost: $${costUsd.toFixed(4)}`],
    maxWords: 60,
  });
}

// ── Main bot factory ──────────────────────────────────────────────────────────

export function createTelegramBot(
  db: Db,
  opts?: {
    heartbeat?: { wakeup: (id: string, opts: WakeupOptions) => Promise<unknown> };
    companyId?: string;
    getHealthSnapshot?: (db: Db) => Promise<WatchdogHealthSnapshot>;
  },
) {
  const tokenRaw = process.env.PAPERCLIP_TELEGRAM_BOT_TOKEN;
  if (!tokenRaw) return null;
  const token: string = tokenRaw;

  const envConfig = parseTelegramGatewayConfigFromEnv();
  if (envConfig.allowedTelegramUserIds.length === 0) {
    logger.warn("PAPERCLIP_TELEGRAM_ALLOWED_USER_IDS not set — Telegram bot disabled");
    return null;
  }

  let operatorChatId: string | null = process.env.PAPERCLIP_TELEGRAM_OPERATOR_CHAT_ID ?? null;

  const gateway = createTelegramGateway({
    ...envConfig,
    dispatch: async () => ({ responseText: "✅ Executat." }),
  });

  // ── Callback query handlers ────────────────────────────────────────────────

  async function handleCallbackQuery(query: {
    id: string;
    data?: string;
    message?: { chat?: { id: number }; message_id?: number };
    from?: { id: number };
  }): Promise<void> {
    const chatId = query.message?.chat?.id ? String(query.message.chat.id) : null;
    const msgId = query.message?.message_id;
    const data = query.data ?? "";

    // Always answer to dismiss spinner
    await tgFetch(token, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);

    if (!chatId) return;

    const companyId = await resolveCompanyId(db, opts?.companyId);

    if (data.startsWith("resume:")) {
      const agentId = data.slice("resume:".length);
      await db.update(agents).set({ status: "idle", pauseReason: null, updatedAt: new Date() }).where(eq(agents.id, agentId));
      const [agent] = await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, agentId));
      const label = agent?.name ?? agent?.role ?? agentId.slice(0, 8);
      if (opts?.heartbeat) await opts.heartbeat.wakeup(agentId, { source: "on_demand", reason: "telegram_resume" }).catch(() => undefined);
      const confirmText = `▶ ${label} repornit`;
      if (msgId) {
        await tgFetch(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
      await sendTelegramMessage(token, chatId, confirmText);

    } else if (data.startsWith("stop:")) {
      const agentId = data.slice("stop:".length);
      await db.update(agents).set({ status: "paused", pauseReason: "telegram: manual stop", pausedAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
      const [agent] = await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, agentId));
      const label = agent?.name ?? agent?.role ?? agentId.slice(0, 8);
      await sendTelegramMessage(token, chatId, `⏸ ${label} pauzat`);

    } else if (data.startsWith("retry_run:")) {
      const issueId = data.slice("retry_run:".length);
      const issue = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId)).then((r) => r[0] ?? null);
      if (issue?.assigneeAgentId && opts?.heartbeat) {
        await opts.heartbeat.wakeup(issue.assigneeAgentId, {
          source: "on_demand",
          reason: "telegram_retry",
          contextSnapshot: { telegramChatId: chatId, issueId },
        });
        await sendTelegramMessage(token, chatId, `🔄 Retry trimis.`);
      }
    }
  }

  // ── Command dispatch ───────────────────────────────────────────────────────

  async function dispatch(chatId: string, text: string, rawUpdate?: unknown): Promise<void> {
    if (!text.startsWith("/")) return;
    const parts = text.trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase().split("@")[0]!;
    const args = parts.slice(1);

    sendTyping(token, chatId);

    const companyId = await resolveCompanyId(db, opts?.companyId);
    if (!companyId) {
      await sendTelegramMessage(token, chatId, "❌ Company not configured.");
      return;
    }

    // Helper: resolve agent from first arg
    async function resolveAgent(alias?: string): Promise<AgentRow | null> {
      if (!alias) return null;
      const { agent, suggestions } = await findAgentByAlias(db, companyId!, alias);
      if (agent) return agent;
      if (suggestions.length > 0) {
        const list = suggestions.map((s) => `• ${s.name ?? s.role ?? s.id.slice(0, 8)}`).join("\n");
        await sendTelegramMessage(token, chatId, `❓ Agent <b>${alias}</b> nu a fost găsit. Vrei să spui:\n${list}`);
      } else {
        await sendTelegramMessage(token, chatId, `❓ Agent <b>${alias}</b> nu există.`);
      }
      return null;
    }

    switch (cmd) {
      case "/help": {
        await sendTelegramMessage(token, chatId, buildHelpReply());
        break;
      }

      case "/agents":
      case "/status": {
        const { text: agentsText, replyMarkup } = await buildAgentsReply(db, companyId);
        await sendTelegramMessage(token, chatId, agentsText, replyMarkup);
        break;
      }

      case "/today": {
        await sendTelegramMessage(token, chatId, await buildTodayReply(db));
        break;
      }

      case "/health": {
        if (!opts?.getHealthSnapshot) {
          await sendTelegramMessage(token, chatId, "❌ Health snapshot not available.");
          break;
        }
        const snapshot = await opts.getHealthSnapshot(db);
        await sendTelegramMessage(token, chatId, await buildHealthReply(snapshot));
        break;
      }

      case "/runs": {
        const alias = args[0];
        const limit = Math.min(parseInt(args[1] ?? "5", 10) || 5, 20);
        if (!alias) {
          await sendTelegramMessage(token, chatId, "Usage: /runs <agent> [n]\nEx: /runs bba 10");
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        await sendTelegramMessage(token, chatId, await buildRunsReply(db, agent.name ?? agent.role ?? alias, agent.id, limit));
        break;
      }

      case "/cost": {
        await sendTelegramMessage(token, chatId, await buildCostReply(db, companyId));
        break;
      }

      case "/logs": {
        const alias = args[0];
        if (!alias) {
          await sendTelegramMessage(token, chatId, "Usage: /logs <agent>\nEx: /logs bba");
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        await sendTelegramMessage(token, chatId, await buildLogsReply(db, agent.name ?? agent.role ?? alias, agent.id));
        break;
      }

      case "/issues": {
        const alias = args[0];
        const agentFilter = alias ? await resolveAgent(alias) : null;
        if (alias && !agentFilter) break;
        await sendTelegramMessage(token, chatId, await buildIssuesReply(db, companyId, agentFilter ?? undefined));
        break;
      }

      case "/ask": {
        const alias = args[0];
        const taskText = args.slice(1).join(" ");
        if (!alias || !taskText) {
          await sendTelegramMessage(token, chatId, "Usage: /ask <agent> <task>\nEx: /ask cto Analizează ultimele runs BBA");
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        if (!opts?.heartbeat) {
          await sendTelegramMessage(token, chatId, "❌ Heartbeat service unavailable.");
          break;
        }
        const [newIssue] = await db.insert(issues).values({
          companyId,
          title: taskText.slice(0, 100),
          description: `${taskText}\n\n— Trimis din Telegram`,
          status: "todo",
          assigneeAgentId: agent.id,
          originKind: "manual",
        }).returning({ id: issues.id });
        const issueId = newIssue!.id;
        await opts.heartbeat.wakeup(agent.id, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "telegram_ask",
          payload: { telegramChatId: chatId, issueId, taskText },
          contextSnapshot: { telegramChatId: chatId, issueId },
        });
        const label = agent.name ?? agent.role ?? alias;
        await sendTelegramMessage(token, chatId,
          `✅ Cerere trimisă la <b>${label}</b>\n<code>${issueId.slice(0, 8)}</code> · Vei primi răspuns la finalizare.`);
        break;
      }

      case "/run": {
        const alias = args[0];
        if (!alias) {
          await sendTelegramMessage(token, chatId, "Usage: /run <agent>\nEx: /run bba");
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        if (!opts?.heartbeat) {
          await sendTelegramMessage(token, chatId, "❌ Heartbeat service unavailable.");
          break;
        }
        await opts.heartbeat.wakeup(agent.id, { source: "on_demand", reason: "telegram_run", contextSnapshot: { telegramChatId: chatId } });
        await sendTelegramMessage(token, chatId, `▶ <b>${agent.name ?? agent.role}</b> pornit.`);
        break;
      }

      case "/stop":
      case "/pause": {
        const alias = args[0];
        if (!alias) {
          // Show all agents with stop buttons
          const all = await db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status }).from(agents).where(eq(agents.companyId, companyId));
          const active = all.filter((a) => a.status !== "paused");
          if (active.length === 0) { await sendTelegramMessage(token, chatId, "Toți agenții sunt deja pauzați."); break; }
          const buttons = active.map((a) => [{ text: `⏸ ${a.name ?? a.role}`, callback_data: `stop:${a.id}` }]);
          await sendTelegramMessage(token, chatId, "Alege agentul de pauzat:", inlineKeyboardMarkup(buttons));
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        await db.update(agents).set({ status: "paused", pauseReason: "telegram: manual stop", pausedAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agent.id));
        const label = agent.name ?? agent.role ?? alias;
        await sendTelegramMessage(token, chatId, `⏸ <b>${label}</b> pauzat.`,
          inlineKeyboardMarkup([[{ text: `▶ Resume ${label}`, callback_data: `resume:${agent.id}` }]]));
        break;
      }

      case "/resume": {
        const alias = args[0];
        if (!alias) {
          const all = await db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status }).from(agents).where(eq(agents.companyId, companyId));
          const paused = all.filter((a) => a.status === "paused");
          if (paused.length === 0) { await sendTelegramMessage(token, chatId, "Niciun agent nu e pauzat."); break; }
          const buttons = paused.map((a) => [{ text: `▶ ${a.name ?? a.role}`, callback_data: `resume:${a.id}` }]);
          await sendTelegramMessage(token, chatId, "Alege agentul de repornit:", inlineKeyboardMarkup(buttons));
          break;
        }
        const agent = await resolveAgent(alias);
        if (!agent) break;
        await db.update(agents).set({ status: "idle", pauseReason: null, updatedAt: new Date() }).where(eq(agents.id, agent.id));
        if (opts?.heartbeat) await opts.heartbeat.wakeup(agent.id, { source: "on_demand", reason: "telegram_resume", contextSnapshot: { telegramChatId: chatId } }).catch(() => undefined);
        await sendTelegramMessage(token, chatId, `▶ <b>${agent.name ?? agent.role ?? alias}</b> repornit.`);
        break;
      }

      case "/cancel": {
        const idPrefix = args[0];
        if (!idPrefix) { await sendTelegramMessage(token, chatId, "Usage: /cancel <issueId prefix>"); break; }
        const rows = await db.select({ id: issues.id, title: issues.title }).from(issues)
          .where(and(eq(issues.companyId, companyId), sql`${issues.id}::text LIKE ${idPrefix + "%"}`))
          .limit(1);
        if (!rows[0]) { await sendTelegramMessage(token, chatId, `❌ Issue <code>${idPrefix}</code> nu a fost găsit.`); break; }
        await db.update(issues).set({ status: "cancelled", updatedAt: new Date() }).where(eq(issues.id, rows[0].id));
        await sendTelegramMessage(token, chatId, `🗑 Issue anulat: <i>${rows[0].title.slice(0, 60)}</i>`);
        break;
      }

      case "/bet": {
        // Syntax: /bet Bayern PSG|BTTS|Da|1.24|30
        const fullArg = args.join(" ");
        const parts2 = fullArg.split("|").map((s) => s.trim());
        if (parts2.length < 5) {
          await sendTelegramMessage(token, chatId,
            "Usage: /bet &lt;match&gt;|&lt;market&gt;|&lt;selection&gt;|&lt;odds&gt;|&lt;stake&gt;\nEx: /bet Bayern PSG|BTTS|Da|1.24|30");
          break;
        }
        const [matchLabel, market, selection, oddsStr, stakeStr] = parts2;
        const odds = parseFloat(oddsStr ?? "");
        const stake = parseFloat(stakeStr ?? "");
        if (!matchLabel || !market || !selection || isNaN(odds) || isNaN(stake)) {
          await sendTelegramMessage(token, chatId, "❌ Format invalid. Verifică odds și stake să fie numere.");
          break;
        }
        const { agent: bba } = await findAgentByAlias(db, companyId, "bba");
        if (!bba) { await sendTelegramMessage(token, chatId, "❌ BBA agent nu a fost găsit."); break; }
        if (!opts?.heartbeat) { await sendTelegramMessage(token, chatId, "❌ Heartbeat unavailable."); break; }

        const issueTitle = `[BET] ${matchLabel} — ${market} ${selection} @${odds} (${stake} RON)`;
        const issueBody = `Plasează pariul următor pe Casa Pariurilor:\n- Match: ${matchLabel}\n- Market: ${market}\n- Selection: ${selection}\n- Odds: ${odds}\n- Stake: ${stake} RON\nsearchQuery: "${matchLabel}"\nTrimis din Telegram de operator.`;

        const [newIssue] = await db.insert(issues).values({
          companyId,
          title: issueTitle.slice(0, 100),
          description: issueBody,
          status: "todo",
          assigneeAgentId: bba.id,
          originKind: "manual",
        }).returning({ id: issues.id });

        await opts.heartbeat.wakeup(bba.id, {
          source: "on_demand",
          reason: "telegram_bet",
          payload: { telegramChatId: chatId, issueId: newIssue!.id },
          contextSnapshot: { telegramChatId: chatId, issueId: newIssue!.id },
        });

        await sendTelegramMessage(token, chatId,
          `✅ Pariu trimis la BBA\n${matchLabel} · ${market} ${selection} · @${odds} · ${stake} RON\nIssue: <code>${newIssue!.id.slice(0, 8)}</code> · Vei primi confirmare la finalizare.`);
        break;
      }

      case "/bankroll": {
        await sendTelegramMessage(token, chatId, await buildTodayReply(db));
        break;
      }

      case "/approve":
      case "/reject": {
        const gwResult = await gateway.handleUpdate(rawUpdate ?? {});
        const gwText = gwResult.responseText
          ?? (gwResult.result === "approved" ? "✅ Aprobat și executat."
             : gwResult.result === "rejected" && gwResult.reason === "approval_not_found" ? "❌ ID approval invalid."
             : gwResult.result === "rejected" ? "❌ Respins."
             : gwResult.result === "invalid" ? "❌ Format invalid. Folosește: /approve <id>"
             : "Command received.");
        await sendTelegramMessage(token, chatId, gwText);
        break;
      }

      default: {
        await sendTelegramMessage(token, chatId, `Comandă necunoscută: <code>${cmd}</code>\nTrimite /help pentru lista completă.`);
        break;
      }
    }
  }

  // ── Polling loop ───────────────────────────────────────────────────────────

  let offset = 0;
  let running = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function poll() {
    if (!running) return;
    try {
      const updates = await tgFetch(token, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      }) as Array<{
        update_id: number;
        message?: { chat?: { id: number }; from?: { id: number }; text?: string };
        callback_query?: { id: string; data?: string; message?: { chat?: { id: number }; message_id?: number }; from?: { id: number } };
      }>;

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query).catch((err) =>
            logger.warn({ err }, "telegram: callback_query handler error"));
          continue;
        }

        const chatId = update.message?.chat?.id;
        if (chatId && !operatorChatId) {
          operatorChatId = String(chatId);
          logger.info({ chatId: operatorChatId }, "telegram: operator chat ID captured");
        }

        const fromId = update.message?.from?.id;
        const allowed = envConfig.allowedTelegramUserIds;
        if (fromId && allowed.length > 0 && !allowed.includes(String(fromId))) continue;

        const text = update.message?.text;
        if (text && chatId) {
          await dispatch(String(chatId), text, update).catch((err) =>
            logger.warn({ err }, "telegram: dispatch error"));
        }
      }
    } catch (err) {
      if (running) logger.warn({ err }, "telegram: poll error");
    }

    if (running) pollTimer = setTimeout(() => void poll(), 1_000);
  }

  function start() {
    if (running) return;
    running = true;
    logger.info({ bot: envConfig.botUsername }, "telegram: polling started");
    void poll();
  }

  function stop() {
    running = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    logger.info("telegram: polling stopped");
  }

  function getOperatorChatId() { return operatorChatId; }

  function send(text: string, replyMarkup?: unknown): Promise<void> {
    if (!operatorChatId) {
      logger.warn("telegram: no operator chat ID yet — send skipped");
      return Promise.resolve();
    }
    return sendTelegramMessage(token, operatorChatId!, text, replyMarkup).catch((err) => {
      logger.warn({ err }, "telegram: outbound send failed");
    });
  }

  function sendToChat(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
    return sendTelegramMessage(token, chatId, text, replyMarkup).catch((err) => {
      logger.warn({ err }, "telegram: sendToChat failed");
    });
  }

  return { start, stop, send, sendToChat, getOperatorChatId };
}

export type TelegramBot = NonNullable<ReturnType<typeof createTelegramBot>>;
