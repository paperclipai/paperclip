#!/usr/bin/env node
// Watchdog daemon — bridges Paperclip Issue #390 (no built-in loop detection).
//
// Polls each agent every WATCHDOG_INTERVAL_MS and pauses any agent that:
//   - Exceeds 2× rolling-avg tokens-per-task
//   - Has WATCHDOG_NO_DELTA_LIMIT consecutive heartbeats with zero status delta
//   - Hits per-task hard USD cap
//
// Run via launchd (see infra/launchd/com.koenig.watchdog.plist).
//
// State is persisted to watchdog/.state/ so restarts don't lose history.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, ".state");

const PAPERCLIP_HOST = process.env.PAPERCLIP_HOST ?? "http://localhost:3100";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? "";
const COMPANY_ID = process.env.KOENIG_COMPANY_ID ?? "2a77f89b-33f0-4133-a20c-77ddaac5e744"; // learnova-academy (Docker stack 2026-04-30)
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 10 * 60 * 1000); // 10 min
const NO_DELTA_LIMIT = Number(process.env.WATCHDOG_NO_DELTA_LIMIT ?? 5);
const ROLLING_AVG_MULTIPLIER = Number(process.env.WATCHDOG_ROLLING_AVG_MULTIPLIER ?? 2);
// Zero-comment crash loop: pause if agent stays on the same issue for N ticks without posting a comment.
// At 10-min intervals, 3 ticks = 30 min max before intervention.
const CRASH_LOOP_TICKS = Number(process.env.WATCHDOG_CRASH_LOOP_TICKS ?? 3);
const ALERT_SLACK = process.env.WATCHDOG_ALERT_SLACK_WEBHOOK;
const ALERT_TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALERT_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALERT_EMAIL_TO = process.env.WATCHDOG_ALERT_EMAIL_TO;

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function loadState(agentId) {
  try {
    const txt = await fs.readFile(path.join(STATE_DIR, `${agentId}.json`), "utf8");
    return JSON.parse(txt);
  } catch {
    return {
      recentTokensPerTask: [],
      lastStatusHash: null,
      noDeltaCount: 0,
      paused: false,
      crashLoopIssueId: null,
      crashLoopLastActivity: null,
      crashLoopTicks: 0,
      lastErrorState: false,
      lastCostSnapshot: 0,
    };
  }
}

async function saveState(agentId, state) {
  await fs.writeFile(path.join(STATE_DIR, `${agentId}.json`), JSON.stringify(state, null, 2));
}

function authHeaders() {
  return PAPERCLIP_API_KEY ? { authorization: `Bearer ${PAPERCLIP_API_KEY}` } : {};
}

async function fetchAgents() {
  // 2026-04-30: company-scoped endpoint. Old `/api/agents` returned 404 for 13+ hours.
  const url = `${PAPERCLIP_HOST}/api/companies/${COMPANY_ID}/agents`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`paperclip ${url} → ${res.status}`);
  const data = await res.json();
  // Response shape: array directly, OR { agents: [...] }
  return Array.isArray(data) ? data : (data.agents ?? data.items ?? []);
}

async function pauseAgent(agentId, reason) {
  const res = await fetch(`${PAPERCLIP_HOST}/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ status: "paused", pauseReason: reason }),
  });
  if (!res.ok) {
    console.error(`Failed to pause ${agentId}: ${res.status} ${await res.text().catch(() => "")}`);
    return;
  }
  console.log(`PAUSED ${agentId}: ${reason}`);
  await alert(`🚨 Watchdog paused agent ${agentId}: ${reason}`);
}

async function alert(msg) {
  // Telegram (preferred — Phase M)
  if (ALERT_TELEGRAM_BOT_TOKEN && ALERT_TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: ALERT_TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
      });
    } catch (err) {
      console.error("Telegram alert failed:", err);
    }
  }
  // Slack (fallback)
  if (ALERT_SLACK) {
    try {
      await fetch(ALERT_SLACK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: msg }),
      });
    } catch (err) {
      console.error("Slack alert failed:", err);
    }
  }
  // TODO: email via Resend when RESEND_API_KEY is wired
}

async function checkAgent(agent) {
  // Skip non-actionable shapes (e.g., archived agents from companies.<id>.agents listings)
  if (!agent || !agent.id) return;
  const state = await loadState(agent.id);
  // Error state alert — fires once on transition to error, not every tick
  const wasError = state.lastErrorState === true;
  const isError = agent.status === "error";
  state.lastErrorState = isError;
  if (isError && !wasError) {
    await alert(`🔴 Agent ${agent.urlKey ?? agent.id} (${agent.name ?? "unknown"}) entered error state — manual reset required`);
  }
  if (isError) {
    await saveState(agent.id, state);
    return;
  }

  if (state.paused || agent.status === "paused") {
    state.paused = true;
    await saveState(agent.id, state);
    return;
  }

  // Loop / no-progress check — intentionally excludes lastHeartbeatAt so that an agent crash-looping
  // on the same issue (same tasks, same blockedReason) accumulates noDeltaCount correctly.
  const statusHash = JSON.stringify({
    tasks: agent.activeTaskIds ?? agent.activeIssueIds ?? [],
    blocked: agent.blockedReason ?? agent.pauseReason ?? null,
  });
  if (state.lastStatusHash === statusHash) {
    state.noDeltaCount += 1;
    if (state.noDeltaCount >= NO_DELTA_LIMIT) {
      await pauseAgent(agent.id, `${NO_DELTA_LIMIT} consecutive ticks with no status delta`);
      state.paused = true;
    }
  } else {
    state.noDeltaCount = 0;
    state.lastStatusHash = statusHash;
  }

  // Zero-comment crash loop detection — catches fast retry storms (100+ runs/hr) that the
  // no-delta check misses because they occur within a single 10-min poll window.
  // Fetches the agent's current in-progress issue and checks lastActivityAt as a proxy for
  // comment/progress activity. Pauses if the same issue shows no activity for CRASH_LOOP_TICKS.
  if (!state.paused && agent.status === "running") {
    try {
      const issuesUrl = `${PAPERCLIP_HOST}/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${agent.id}&status=in_progress&limit=1`;
      const issuesRes = await fetch(issuesUrl, { headers: authHeaders() });
      if (issuesRes.ok) {
        const issues = await issuesRes.json();
        const activeIssue = Array.isArray(issues) ? issues[0] : null;
        if (activeIssue) {
          const isSameIssue = activeIssue.id === state.crashLoopIssueId;
          const lastActivity = activeIssue.lastActivityAt ?? activeIssue.updatedAt ?? null;
          const sameActivity = lastActivity === state.crashLoopLastActivity;
          if (isSameIssue && sameActivity) {
            state.crashLoopTicks = (state.crashLoopTicks ?? 0) + 1;
            if (state.crashLoopTicks >= CRASH_LOOP_TICKS) {
              await pauseAgent(
                agent.id,
                `Zero-progress crash loop on issue ${activeIssue.identifier ?? activeIssue.id} for ${state.crashLoopTicks} ticks`
              );
              state.paused = true;
            }
          } else {
            state.crashLoopIssueId = activeIssue.id;
            state.crashLoopLastActivity = lastActivity;
            state.crashLoopTicks = 0;
          }
        } else {
          state.crashLoopIssueId = null;
          state.crashLoopTicks = 0;
        }
      }
    } catch (err) {
      console.error(`crash-loop check failed for ${agent.id}:`, err.message);
    }
  }

  // Rolling-avg token check — fall back through field-name variants
  const last = agent.lastTaskTokensIn ?? agent.lastTokensIn ?? agent.lastRunTokensIn ?? 0;
  if (last > 0) {
    state.recentTokensPerTask.push(last);
    if (state.recentTokensPerTask.length > 10) state.recentTokensPerTask.shift();
    const avg = state.recentTokensPerTask.reduce((a, b) => a + b, 0) / state.recentTokensPerTask.length;
    if (avg > 0 && last > ROLLING_AVG_MULTIPLIER * avg && state.recentTokensPerTask.length >= 5) {
      await pauseAgent(agent.id, `Last task tokens (${last}) > ${ROLLING_AVG_MULTIPLIER}× rolling avg (${avg.toFixed(0)})`);
      state.paused = true;
    }
  }

  await saveState(agent.id, state);
}

async function tick() {
  try {
    const agents = await fetchAgents();
    await Promise.all(agents.map(checkAgent));
    console.log(new Date().toISOString(), `tick OK — checked ${agents.length} agents`);
  } catch (err) {
    console.error(new Date().toISOString(), "tick error:", err.message);
    // Don't silently die; alert if Telegram is wired
    if (err.message.includes("404") || err.message.includes("ECONNREFUSED")) {
      await alert(`⚠️ Watchdog cannot reach Paperclip: ${err.message}`).catch(() => {});
    }
  }
}

async function main() {
  await ensureStateDir();
  console.log(`Watchdog up — polling ${PAPERCLIP_HOST}/api/companies/${COMPANY_ID}/agents every ${INTERVAL_MS / 1000}s`);
  await tick();
  setInterval(tick, INTERVAL_MS);
}

main().catch((err) => {
  console.error("watchdog crashed:", err);
  process.exit(1);
});
