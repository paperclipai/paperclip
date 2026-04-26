#!/usr/bin/env node
/**
 * kpi-monitor.mjs — Autonomous token-KPI poller for Paperclip.
 *
 * Polls /api/companies/:companyId/heartbeat-runs on a configurable interval,
 * computes per-run and rolling token averages for resumed sessions, and emits
 * structured JSONL records to a log file.
 *
 * When an anomaly or a "done" condition is detected, posts a comment to the
 * linked Paperclip issue so the agent is notified on its next wake.
 *
 * The agent NEVER polls — this script does it instead.
 *
 * Usage:
 *   node scripts/kpi-monitor.mjs [options]
 *
 * Options:
 *   --interval <seconds>     Poll interval (default: 120)
 *   --duration <minutes>     Total run time before auto-exit (default: 60)
 *   --runs <n>               Number of completed runs to collect before exiting (default: 10)
 *   --log <path>             JSONL log file (default: /tmp/kpi-monitor.jsonl)
 *   --agent-id <id>          Filter by agent id (defaults to PAPERCLIP_AGENT_ID)
 *   --issue-id <id>          Issue to notify (defaults to PAPERCLIP_TASK_ID)
 *   --baseline-tokens <n>    Known baseline avg input tokens for comparison
 *   --notify-threshold <pct> Alert if avg deviates from baseline by this % (default: 15)
 *   --dry-run                Skip posting comments; print to stdout instead
 *
 * Environment (auto-injected in heartbeat, or set manually):
 *   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID,
 *   PAPERCLIP_AGENT_ID, PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID
 *
 * Design:
 *   loop:
 *     poll -> collect new completed runs
 *     compute rolling avg input tokens for resumed sessions
 *     write JSONL record (benign: inspect file, not the agent)
 *     if anomaly OR collection complete -> notify agent via issue comment
 *     if duration elapsed OR run-count reached -> exit
 */

import { createWriteStream } from "fs";
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// ── Config ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    interval:           { type: "string", default: "120" },
    duration:           { type: "string", default: "60" },
    runs:               { type: "string", default: "10" },
    log:                { type: "string", default: "/tmp/kpi-monitor.jsonl" },
    "agent-id":         { type: "string" },
    "issue-id":         { type: "string" },
    "baseline-tokens":  { type: "string" },
    "notify-threshold": { type: "string", default: "15" },
    "dry-run":          { type: "boolean", default: false },
  },
  strict: false,
});

const API_URL          = process.env.PAPERCLIP_API_URL   || "http://localhost:3100";
const API_KEY          = process.env.PAPERCLIP_API_KEY   || "";
const COMPANY_ID       = process.env.PAPERCLIP_COMPANY_ID || "";
const AGENT_ID         = args["agent-id"] || process.env.PAPERCLIP_AGENT_ID || "";
const ISSUE_ID         = args["issue-id"] || process.env.PAPERCLIP_TASK_ID  || "";
const RUN_ID           = process.env.PAPERCLIP_RUN_ID    || "";
const INTERVAL_MS      = parseInt(args.interval, 10) * 1000;
const DURATION_MS      = parseInt(args.duration,  10) * 60 * 1000;
const TARGET_RUN_COUNT = parseInt(args.runs,      10);
const LOG_FILE         = args.log;
const BASELINE_TOKENS  = args["baseline-tokens"] ? parseFloat(args["baseline-tokens"]) : null;
const NOTIFY_THRESHOLD = parseFloat(args["notify-threshold"]) / 100;
const DRY_RUN          = args["dry-run"];

if (!COMPANY_ID) {
  console.error("PAPERCLIP_COMPANY_ID is required");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
  console.log(line);
}

async function apiFetch(path, opts = {}) {
  const url = `${API_URL}/api${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(RUN_ID ? { "X-Paperclip-Run-Id": RUN_ID } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function getRecentRuns(limit = 100) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (AGENT_ID) qs.set("agentId", AGENT_ID);
  const data = await apiFetch(`/companies/${COMPANY_ID}/heartbeat-runs?${qs}`);
  return Array.isArray(data) ? data : (data.runs || data.data || []);
}

async function postComment(body) {
  if (!ISSUE_ID) {
    console.log("[kpi-monitor] No issue id — skipping comment:", body.slice(0, 80));
    return;
  }
  if (DRY_RUN) {
    console.log("[kpi-monitor] [dry-run] comment:\n" + body);
    return;
  }
  await apiFetch(`/issues/${ISSUE_ID}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function computeStats(runs) {
  // Only resumed (non-fresh) sessions are relevant for compression savings
  const resumed = runs.filter(r => {
    const u = r.usageJson;
    return u && u.freshSession === false && u.inputTokens != null;
  });
  if (!resumed.length) return null;

  const inputTokens = resumed.map(r => r.usageJson.inputTokens);
  const cachedTokens = resumed.map(r => r.usageJson.cachedInputTokens || 0);
  const costs = resumed.map(r => r.usageJson.costUsd || 0);

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = arr => Math.min(...arr);
  const max = arr => Math.max(...arr);

  return {
    count: resumed.length,
    avgInputTokens: avg(inputTokens),
    minInputTokens: min(inputTokens),
    maxInputTokens: max(inputTokens),
    avgCachedTokens: avg(cachedTokens),
    avgCostUsd: avg(costs),
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  let collectedRunIds = new Set();
  let resumedRunsCollected = 0;
  let notifiedAnomaly = false;
  let cycle = 0;

  log({
    event: "monitor_start",
    agentId: AGENT_ID,
    issueId: ISSUE_ID,
    intervalMs: INTERVAL_MS,
    durationMs: DURATION_MS,
    targetRunCount: TARGET_RUN_COUNT,
    baselineTokens: BASELINE_TOKENS,
    notifyThresholdPct: NOTIFY_THRESHOLD * 100,
    logFile: LOG_FILE,
  });

  while (true) {
    cycle++;
    const elapsed = Date.now() - startTime;

    if (elapsed >= DURATION_MS) {
      log({ event: "duration_elapsed", elapsedMs: elapsed, cycles: cycle });
      break;
    }

    // Poll
    let runs;
    try {
      runs = await getRecentRuns(200);
    } catch (err) {
      log({ event: "poll_error", error: err.message, cycle });
      await sleep(INTERVAL_MS);
      continue;
    }

    const completed = runs.filter(r => r.status === "succeeded" || r.status === "failed");
    const newRuns = completed.filter(r => !collectedRunIds.has(r.id));
    newRuns.forEach(r => collectedRunIds.add(r.id));

    const stats = computeStats(completed);
    const newResumedCount = newRuns.filter(r => r.usageJson?.freshSession === false).length;
    resumedRunsCollected += newResumedCount;

    // Record JSONL entry (always — benign in-progress data for later inspection)
    log({
      event: "poll",
      cycle,
      elapsedMs: elapsed,
      totalCompleted: completed.length,
      newRunsThisCycle: newRuns.length,
      resumedRunsCollected,
      stats,
    });

    // Anomaly detection
    if (stats && BASELINE_TOKENS !== null && !notifiedAnomaly) {
      const deviation = (stats.avgInputTokens - BASELINE_TOKENS) / BASELINE_TOKENS;
      if (Math.abs(deviation) > NOTIFY_THRESHOLD) {
        notifiedAnomaly = true;
        const direction = deviation > 0 ? "INCREASE" : "DECREASE";
        const msg = [
          `## KPI Monitor: Token Anomaly Detected`,
          ``,
          `- Direction: **${direction}** (${(deviation * 100).toFixed(1)}%)`,
          `- Avg input tokens (current): **${stats.avgInputTokens.toFixed(0)}**`,
          `- Baseline: **${BASELINE_TOKENS}**`,
          `- Threshold: ±${(NOTIFY_THRESHOLD * 100).toFixed(0)}%`,
          `- Resumed runs sampled: ${stats.count}`,
          `- Avg cost/run: $${stats.avgCostUsd.toFixed(6)}`,
          ``,
          `Log: \`${LOG_FILE}\``,
        ].join("\n");

        log({ event: "anomaly_notify", deviation, stats });
        try { await postComment(msg); } catch (e) { log({ event: "comment_error", error: e.message }); }
      }
    }

    // Completion check — enough resumed runs collected
    if (resumedRunsCollected >= TARGET_RUN_COUNT) {
      log({ event: "target_reached", resumedRunsCollected, stats });
      const msg = [
        `## KPI Monitor: Collection Complete`,
        ``,
        `Collected **${resumedRunsCollected}** resumed-session heartbeat runs.`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        stats
          ? [
              `| Avg input tokens | ${stats.avgInputTokens.toFixed(0)} |`,
              `| Min / Max input  | ${stats.minInputTokens} / ${stats.maxInputTokens} |`,
              `| Avg cached tokens| ${stats.avgCachedTokens.toFixed(0)} |`,
              `| Avg cost/run     | $${stats.avgCostUsd.toFixed(6)} |`,
              `| Total cost       | $${stats.totalCostUsd.toFixed(4)} |`,
              BASELINE_TOKENS !== null
                ? `| vs baseline      | ${((stats.avgInputTokens - BASELINE_TOKENS) / BASELINE_TOKENS * 100).toFixed(1)}% |`
                : "",
            ].filter(Boolean).join("\n")
          : "| (no resumed sessions yet) | — |",
        ``,
        `Log: \`${LOG_FILE}\``,
      ].join("\n");

      try { await postComment(msg); } catch (e) { log({ event: "comment_error", error: e.message }); }
      break;
    }

    await sleep(INTERVAL_MS);
  }

  // Final summary to log
  const runs = await getRecentRuns(200).catch(() => []);
  const completed = runs.filter(r => r.status === "succeeded" || r.status === "failed");
  const finalStats = computeStats(completed);
  log({ event: "monitor_done", finalStats, resumedRunsCollected });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error("[kpi-monitor] Fatal:", err);
  process.exit(1);
});
