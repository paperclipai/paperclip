#!/usr/bin/env node
/**
 * Paperclip issue heartbeat run forensics (read-only).
 * Uses only Node built-ins (http/https) — no pnpm deps required to run.
 *
 * Usage:
 *   node scripts/issue-run-forensics.mjs --company <uuid> --issue ROU-20
 *   node scripts/issue-run-forensics.mjs --company <uuid> --issue ROU-20 --run 4
 *   node scripts/issue-run-forensics.mjs --company <uuid> --issue ROU-20 --run-id <uuid>
 *   node scripts/issue-run-forensics.mjs --company <uuid> --issue ROU-20 --issue-activity
 *   node scripts/issue-run-forensics.mjs --company <uuid> --issue ROU-20 --reverse-last-per-run
 *
 * Env: PAPERCLIP_API_BASE, PAPERCLIP_AUTH
 *
 * --run N  : 1-based index after sorting runs by createdAt ascending.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--company") out.company = argv[++i];
    else if (a === "--issue") out.issue = argv[++i];
    else if (a === "--run") out.run = argv[++i];
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--auth") out.auth = argv[++i];
    else if (a === "--events-limit") out.eventsLimit = argv[++i];
    else if (a === "--prompt-chars") out.promptChars = argv[++i];
    else if (a === "--prompt-excerpt") out.promptExcerpt = argv[++i];
    else if (a === "--issue-activity") out.issueActivity = true;
    else if (a === "--reverse-last-per-run") out.reverseLastPerRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function requestJson(urlStr, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const port = u.port || (u.protocol === "https:" ? 443 : 80);
    const req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} ${urlStr}\n${body.slice(0, 800)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${urlStr}: ${body.slice(0, 240)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function iso(d) {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toISOString();
}

function pickWakeReason(contextSnapshot) {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  return contextSnapshot.wakeReason ?? contextSnapshot.reason ?? null;
}

function snippet(obj, max = 140) {
  if (!obj) return "";
  try {
    const s = JSON.stringify(obj);
    return s.replace(/\s+/g, " ").slice(0, max);
  } catch {
    return "";
  }
}

function printRunTable(runsAsc) {
  console.log("\n## Runs (createdAt ascending, 1-based index)\n");
  console.log("| # | runId | status | adapter | invocation | wakeReason | errorCode |");
  console.log("|---|-------|--------|---------|------------|------------|-----------|");
  runsAsc.forEach((r, i) => {
    const c = r.contextSnapshot && typeof r.contextSnapshot === "object" ? r.contextSnapshot : {};
    console.log(
      `| ${i + 1} | ${r.runId} | ${r.status} | ${r.adapterType ?? ""} | ${r.invocationSource ?? ""} | ${pickWakeReason(c) ?? ""} | ${r.errorCode ?? ""} |`,
    );
  });
  console.log("");
}

function extractAdapterPrompt(events, maxChars) {
  if (!Array.isArray(events)) return { command: null, prompt: null };
  const invoke = [...events].reverse().find((e) => e.eventType === "adapter.invoke");
  if (!invoke?.payload || typeof invoke.payload !== "object") return { command: null, prompt: null };
  const p = invoke.payload;
  const cmd = typeof p.command === "string" ? p.command : null;
  const prompt = typeof p.prompt === "string" ? p.prompt : null;
  if (!prompt) return { command: cmd, prompt: null };
  return {
    command: cmd,
    prompt:
      prompt.length > maxChars
        ? `${prompt.slice(0, maxChars)}\n... (${prompt.length} chars total, truncated)`
        : prompt,
  };
}

async function dumpRunForensics(base, auth, issueRef, runId, eventsLimit, promptChars) {
  const encIssue = encodeURIComponent(issueRef);
  const [run, events, activities] = await Promise.all([
    requestJson(`${base}/api/heartbeat-runs/${runId}`, { auth }),
    requestJson(`${base}/api/heartbeat-runs/${runId}/events?limit=${eventsLimit}`, { auth }),
    requestJson(`${base}/api/issues/${encIssue}/activity`, { auth }),
  ]);

  const acts = Array.isArray(activities)
    ? activities.filter((a) => a.runId === runId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    : [];

  const cs = run.contextSnapshot && typeof run.contextSnapshot === "object" ? run.contextSnapshot : {};

  console.log(`\n## Run detail: ${runId}\n`);
  console.log(
    JSON.stringify(
      {
        status: run.status,
        createdAt: iso(run.createdAt),
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        agentId: run.agentId,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        wakeupRequestId: run.wakeupRequestId,
        errorCode: run.errorCode,
        error: run.error,
        retryOfRunId: run.retryOfRunId,
        processLossRetryCount: run.processLossRetryCount,
        wakeReason: cs.wakeReason,
        wakeSource: cs.wakeSource,
        wakeCommentId: cs.wakeCommentId ?? cs.commentId,
      },
      null,
      2,
    ),
  );

  console.log(`\n## Events (limit ${eventsLimit})\n`);
  if (!Array.isArray(events) || events.length === 0) {
    console.log("(none)\n");
  } else {
    for (const e of events) {
      const msg = typeof e.message === "string" ? e.message.replace(/\s+/g, " ").slice(0, 120) : "";
      console.log(`seq=${e.seq} type=${e.eventType} stream=${e.stream} level=${e.level} ${msg}`);
    }
    const invoke = [...events].reverse().find((e) => e.eventType === "adapter.invoke");
    if (invoke?.payload && typeof invoke.payload === "object") {
      const p = invoke.payload;
      const prompt = typeof p.prompt === "string" ? p.prompt : null;
      const cmd = typeof p.command === "string" ? p.command : null;
      console.log("\n## adapter.invoke payload (excerpt)\n");
      if (cmd) console.log("command:", cmd);
      if (prompt) {
        console.log(`prompt (first ${promptChars} chars):\n`);
        console.log(prompt.slice(0, promptChars));
        if (prompt.length > promptChars) console.log("\n... (truncated)");
      } else {
        console.log("(no prompt string on this event payload — check full GET in browser/curl)");
      }
    }
    console.log("");
  }

  console.log(`## Activity rows for this runId (count=${acts.length})\n`);
  if (acts.length === 0) {
    console.log("(none)\n");
    return;
  }
  for (const a of acts) {
    const snip = a.details?.bodySnippet ? String(a.details.bodySnippet).replace(/\s+/g, " ").slice(0, 100) : "";
    console.log(
      `${iso(a.createdAt)} action=${a.action} actor=${a.actorType}:${a.actorId} agentId=${a.agentId ?? ""} ${snip}`,
    );
  }
  const last = acts[acts.length - 1];
  console.log("\n## Last activity (by createdAt for this runId)\n");
  console.log(JSON.stringify(last, null, 2));
  console.log("");
}

function printIssueActivityAll(activities, issueLabel) {
  console.log(`\n## Issue activity (all rows): ${issueLabel}\n`);
  if (!Array.isArray(activities) || activities.length === 0) {
    console.log("(none)\n");
    return;
  }
  const rows = [...activities].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  console.log("| # | createdAt | action | actor | agentId | runId | details excerpt |");
  console.log("|---|-----------|--------|-------|---------|-------|-----------------|");
  rows.forEach((a, i) => {
    const ex = snippet(a.details, 120);
    console.log(
      `| ${i + 1} | ${iso(a.createdAt)} | ${a.action} | ${a.actorType}:${a.actorId} | ${a.agentId ?? ""} | ${a.runId ?? ""} | ${ex} |`,
    );
  });
  console.log("");
}

async function printReverseLastPerRun(base, auth, issueRef, runsAsc, eventsLimit, promptExcerpt) {
  const encIssue = encodeURIComponent(issueRef);
  const activities = await requestJson(`${base}/api/issues/${encIssue}/activity`, { auth });

  console.log("\n## Reverse trace: last activity per run (runs in createdAt order)\n");

  for (let i = 0; i < runsAsc.length; i++) {
    const runRow = runsAsc[i];
    const runId = runRow.runId;
    const acts = Array.isArray(activities)
      ? activities.filter((a) => a.runId === runId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      : [];
    const last = acts.length ? acts[acts.length - 1] : null;

    const [run, events] = await Promise.all([
      requestJson(`${base}/api/heartbeat-runs/${runId}`, { auth }),
      requestJson(`${base}/api/heartbeat-runs/${runId}/events?limit=${eventsLimit}`, { auth }),
    ]);
    const cs = run.contextSnapshot && typeof run.contextSnapshot === "object" ? run.contextSnapshot : {};
    const { command, prompt } = extractAdapterPrompt(events, promptExcerpt);

    console.log(`\n### Run #${i + 1}  \`${runId}\`\n`);
    console.log("**Run summary**");
    console.log(
      `- status: ${run.status} | wakeReason: ${cs.wakeReason ?? ""} | invocation: ${run.invocationSource}/${run.triggerDetail}`,
    );
    console.log(`- errorCode: ${run.errorCode ?? ""} | error: ${(run.error ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    console.log(`- retryOfRunId: ${run.retryOfRunId ?? ""} | processLossRetryCount: ${run.processLossRetryCount ?? ""}`);
    console.log(`- time: created ${iso(run.createdAt)} | started ${iso(run.startedAt)} | finished ${iso(run.finishedAt)}`);

    if (!last) {
      console.log("\n**Last activity (this runId)**: *(none)*\n");
      continue;
    }
    console.log("\n**Last activity (this runId, by createdAt)**");
    console.log(`- time: ${iso(last.createdAt)}`);
    console.log(`- action: ${last.action}`);
    console.log(`- actor: ${last.actorType} / ${last.actorId}`);
    console.log(`- agentId on row: ${last.agentId ?? ""}`);
    console.log(`- details.source: ${last.details?.source ?? ""}`);
    console.log(`- details excerpt: ${snippet(last.details, 220)}`);

    console.log("\n**Who initiated (interpretation)**");
    console.log(
      `- Wake scheduling: run.invocationSource=\`${run.invocationSource}\`, wakeReason=\`${cs.wakeReason ?? ""}\`, wakeSource=\`${cs.wakeSource ?? ""}\` (see server heartbeat services).`,
    );
    console.log(
      `- Last activity actor: \`${last.actorType}:${last.actorId}\` (activity log actor for that mutation).`,
    );

    console.log("\n**Who executed**");
    console.log(`- Heartbeat agent: \`${run.agentId}\` (see company agents for display name).`);
    if (command) console.log(`- OS command (adapter.invoke): \`${command}\``);

    console.log("\n**Prompt excerpt (adapter.invoke)**\n");
    if (prompt) console.log("```text\n" + prompt + "\n```\n");
    else console.log("*(no prompt captured on adapter.invoke for this run)*\n");
  }
}

function printHelp() {
  console.log(`
Paperclip issue run forensics (read-only, Node stdlib only).

  node scripts/issue-run-forensics.mjs --company <companyUuid> --issue <REF|uuid> [--base URL]

List runs only (sorted by createdAt ascending):

  node scripts/issue-run-forensics.mjs --company … --issue ROU-20

Full issue activity table (newest first):

  node scripts/issue-run-forensics.mjs --company … --issue ROU-20 --issue-activity

Reverse-trace last activity + short prompt for EACH run on the issue:

  node scripts/issue-run-forensics.mjs --company … --issue ROU-20 --reverse-last-per-run

Deep-dive run #N:

  node scripts/issue-run-forensics.mjs --company … --issue ROU-20 --run 4

Deep-dive by run UUID:

  node scripts/issue-run-forensics.mjs --company … --issue ROU-20 --run-id <uuid>

Do not combine --run / --run-id with --reverse-last-per-run (script will error).

Optional:
  --auth "Bearer …"
  --events-limit 200
  --prompt-chars 4000        (only for single-run --run dump)
  --prompt-excerpt 1200      (only for --reverse-last-per-run, default 1200)

Env: PAPERCLIP_API_BASE, PAPERCLIP_AUTH
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const base = (args.base || process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
  const auth = args.auth || process.env.PAPERCLIP_AUTH || "";
  const company = args.company;
  const issue = args.issue;
  const eventsLimit = Math.min(500, Math.max(1, parseInt(args.eventsLimit ?? "200", 10) || 200));
  const promptChars = Math.min(100_000, Math.max(200, parseInt(args.promptChars ?? "4000", 10) || 4000));
  const promptExcerpt = Math.min(20_000, Math.max(400, parseInt(args.promptExcerpt ?? "1200", 10) || 1200));

  if (!company || !issue) {
    printHelp();
    process.exit(1);
  }

  if (args.reverseLastPerRun && (args.run || args.runId)) {
    console.error("Do not combine --reverse-last-per-run with --run or --run-id.");
    process.exit(5);
  }

  const encIssue = encodeURIComponent(issue);
  const issueRow = await requestJson(`${base}/api/issues/${encIssue}`, { auth: auth || undefined });
  if (issueRow.companyId !== company) {
    console.error(
      `company mismatch: flag --company ${company} but issue.companyId=${issueRow.companyId} (identifier=${issueRow.identifier})`,
    );
    process.exit(2);
  }

  console.log(`\n# Issue ${issueRow.identifier ?? issue} (${issueRow.id}) status=${issueRow.status}\n`);

  const runs = await requestJson(`${base}/api/issues/${encIssue}/runs`, { auth: auth || undefined });
  if (!Array.isArray(runs)) {
    console.error("Unexpected /runs response:", typeof runs);
    process.exit(3);
  }

  const runsAsc = [...runs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  printRunTable(runsAsc);

  if (args.issueActivity) {
    const activities = await requestJson(`${base}/api/issues/${encIssue}/activity`, { auth: auth || undefined });
    printIssueActivityAll(activities, issueRow.identifier ?? issue);
  }

  if (args.reverseLastPerRun) {
    await printReverseLastPerRun(base, auth || undefined, issue, runsAsc, eventsLimit, promptExcerpt);
  }

  let targetId = args.runId;
  if (!targetId && args.run) {
    const n = parseInt(String(args.run), 10);
    if (!Number.isFinite(n) || n < 1 || n > runsAsc.length) {
      console.error(`--run must be 1..${runsAsc.length} for this issue`);
      process.exit(4);
    }
    targetId = runsAsc[n - 1].runId;
  }

  if (targetId) {
    await dumpRunForensics(base, auth || undefined, issue, targetId, eventsLimit, promptChars);
  } else if (!args.issueActivity && !args.reverseLastPerRun) {
    console.log("Tip: add --issue-activity and/or --reverse-last-per-run, or pass --run N / --run-id <uuid>.\n");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
