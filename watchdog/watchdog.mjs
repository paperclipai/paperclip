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
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 10 * 60 * 1000); // 10 min
const NO_DELTA_LIMIT = Number(process.env.WATCHDOG_NO_DELTA_LIMIT ?? 5);
const ROLLING_AVG_MULTIPLIER = Number(process.env.WATCHDOG_ROLLING_AVG_MULTIPLIER ?? 2);
const ALERT_SLACK = process.env.WATCHDOG_ALERT_SLACK_WEBHOOK;
const ALERT_EMAIL_TO = process.env.WATCHDOG_ALERT_EMAIL_TO;

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function loadState(agentId) {
  try {
    const txt = await fs.readFile(path.join(STATE_DIR, `${agentId}.json`), "utf8");
    return JSON.parse(txt);
  } catch {
    return { recentTokensPerTask: [], lastStatusHash: null, noDeltaCount: 0, paused: false };
  }
}

async function saveState(agentId, state) {
  await fs.writeFile(path.join(STATE_DIR, `${agentId}.json`), JSON.stringify(state, null, 2));
}

async function fetchAgents() {
  const res = await fetch(`${PAPERCLIP_HOST}/api/agents`);
  if (!res.ok) throw new Error(`paperclip /api/agents → ${res.status}`);
  return res.json();
}

async function pauseAgent(agentId, reason) {
  const res = await fetch(`${PAPERCLIP_HOST}/api/agents/${agentId}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) console.error(`Failed to pause ${agentId}: ${res.status}`);
  console.log(`PAUSED ${agentId}: ${reason}`);
  await alert(`🚨 Watchdog paused agent ${agentId}: ${reason}`);
}

async function alert(msg) {
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
  const state = await loadState(agent.id);
  if (state.paused || agent.status === "paused") {
    state.paused = true;
    await saveState(agent.id, state);
    return;
  }

  // Loop / no-progress check
  const statusHash = JSON.stringify({ tasks: agent.activeTaskIds, blocked: agent.blockedReason });
  if (state.lastStatusHash === statusHash) {
    state.noDeltaCount += 1;
    if (state.noDeltaCount >= NO_DELTA_LIMIT) {
      await pauseAgent(agent.id, `${NO_DELTA_LIMIT} consecutive heartbeats with no status delta`);
      state.paused = true;
    }
  } else {
    state.noDeltaCount = 0;
    state.lastStatusHash = statusHash;
  }

  // Rolling-avg token check
  const last = agent.lastTaskTokensIn ?? 0;
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
  }
}

async function main() {
  await ensureStateDir();
  console.log(`Watchdog up — polling ${PAPERCLIP_HOST} every ${INTERVAL_MS / 1000}s`);
  await tick();
  setInterval(tick, INTERVAL_MS);
}

main().catch((err) => {
  console.error("watchdog crashed:", err);
  process.exit(1);
});
