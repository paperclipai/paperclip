#!/usr/bin/env node
// SLO monitor: output_summary coverage over rolling 2h window.
// Routine: 2b45e1ea-4f02-4dde-b9ee-87915c5f114e (SLO: summary-coverage monitor)
// Parent issue: AKS-1284 (9e131a4b-e30b-424a-871e-2b02d2bdccbf)
// State table: slo_state_summary_coverage in shared Supabase
//
// Spec (AKS-1284 plan v2):
//   metric  = output_summary NOT NULL fraction over trailing 2h, grace 15 min
//   target  = >= 0.80 per sample
//   alarm   = 2 consecutive samples below threshold (one child issue + parent comment)
//   recover = 1 sample back at threshold (parent + child comments)

const SUPABASE_URL = process.env.SHARED_SUPABASE_URL;
const SUPABASE_KEY = process.env.SHARED_SUPABASE_SERVICE_ROLE;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "7ac59b74-cfaf-410e-8311-8462f8eb6d2d";
const PAPERCLIP_RUN_ID = process.env.PAPERCLIP_RUN_ID;

const THRESHOLD = 0.80;
const WINDOW_HOURS = 2;
const GRACE_MINUTES = 15;
const MIN_DENOMINATOR = 20;
const BREACH_STREAK_TRIGGER = 2;
const STATE_RETENTION_HOURS = 72;

// AKS-1284: long-lived SLO tracker where alarms are posted
const PARENT_ISSUE_ID = "9e131a4b-e30b-424a-871e-2b02d2bdccbf";
const PARENT_ISSUE_IDENTIFIER = "AKS-1284";
const DATA_ENGINEER_AGENT_ID = "4cf3fa95-4598-4577-ae95-cdea5764fd30";
const GOAL_ID = "2f09e797-8222-4acf-bf09-8ff8e2b4b464";

async function sbFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SHARED_SUPABASE_URL or SHARED_SUPABASE_SERVICE_ROLE");
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${options.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function pcFetch(path, options = {}) {
  if (!PAPERCLIP_API_KEY) throw new Error("Missing PAPERCLIP_API_KEY");
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
      ...(PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip ${options.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function sampleCoverage() {
  const now = new Date();
  const windowStart = new Date(now - WINDOW_HOURS * 60 * 60 * 1000);
  const graceCutoff = new Date(now - GRACE_MINUTES * 60 * 1000);

  const ws = windowStart.toISOString();
  const gc = graceCutoff.toISOString();

  const rows = await sbFetch(
    `agent_runs?select=output_summary` +
    `&status=eq.completed` +
    `&created_at=gte.${encodeURIComponent(ws)}` +
    `&created_at=lt.${encodeURIComponent(gc)}`,
  );

  const total = rows.length;
  const withSummary = rows.filter((r) => r.output_summary != null).length;

  return { total, withSummary, windowStart, graceCutoff, sampledAt: now };
}

async function getLastState() {
  const rows = await sbFetch(
    `slo_state_summary_coverage?order=sampled_at.desc&limit=1`,
  );
  return rows?.[0] ?? null;
}

async function insertState(row) {
  await sbFetch(`slo_state_summary_coverage`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}

async function markAlarmFired(sampledAt) {
  await sbFetch(
    `slo_state_summary_coverage?sampled_at=eq.${encodeURIComponent(sampledAt)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ alarm_fired: true }),
    },
  );
}

async function trimOldState() {
  const cutoff = new Date(Date.now() - STATE_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  await sbFetch(
    `slo_state_summary_coverage?sampled_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  ).catch((e) => console.warn("State trim failed:", e.message));
}

async function postParentComment(body) {
  await pcFetch(`/api/issues/${PARENT_ISSUE_ID}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function createBreachIssue(coverage, sampledAt) {
  const pct = (coverage * 100).toFixed(1);
  const ts = new Date(sampledAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return pcFetch(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `SLO breach: summary-coverage ${pct}% (${ts})`,
      description:
        `Auto-filed by [AKS-1750](/AKS/issues/AKS-1750) SLO monitor.\n\n` +
        `Coverage dropped to ${pct}% at ${ts}. Investigate and resolve.\n\n` +
        `Parent: [${PARENT_ISSUE_IDENTIFIER}](/AKS/issues/${PARENT_ISSUE_IDENTIFIER})`,
      status: "todo",
      priority: "high",
      parentId: PARENT_ISSUE_ID,
      goalId: GOAL_ID,
      assigneeAgentId: DATA_ENGINEER_AGENT_ID,
    }),
  });
}

async function postBreachComment(coverage, total, streak, windowStart, graceCutoff) {
  const pct = (coverage * 100).toFixed(1);
  const ws = windowStart.toISOString();
  const gc = graceCutoff.toISOString();
  const runRef = PAPERCLIP_RUN_ID ? PAPERCLIP_RUN_ID : "n/a";
  await postParentComment(
    `## SLO breach: summary-coverage\n\n` +
    `**Coverage: ${pct}%** (threshold: 80%) — breach streak: **${streak}**\n\n` +
    `| Metric | Value |\n|--------|-------|\n` +
    `| Coverage | ${pct}% |\n` +
    `| Runs in window | ${total} |\n` +
    `| Breach streak | ${streak} |\n` +
    `| Window | ${ws} → ${gc} (last 2h, grace 15 min) |\n` +
    `| Routine run | ${runRef} |\n\n` +
    `Two consecutive samples below 80%. Child breach issue filed.`,
  );
}

async function postRecoveryComment(coverage, breachIssueIdentifier) {
  const pct = (coverage * 100).toFixed(1);
  const breachRef = breachIssueIdentifier
    ? ` Breach issue: [${breachIssueIdentifier}](/AKS/issues/${breachIssueIdentifier}).`
    : "";
  await postParentComment(
    `## SLO recovered: summary-coverage\n\n` +
    `Coverage returned to **${pct}%** (threshold: 80%). Alarm cleared.${breachRef}`,
  );
}

async function postBreachIssueRecovery(breachIssueId, coverage) {
  const pct = (coverage * 100).toFixed(1);
  await pcFetch(`/api/issues/${breachIssueId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body:
        `Coverage has recovered to **${pct}%** (threshold: 80%). Alarm cleared. ` +
        `Close this issue when the underlying cause is understood.`,
    }),
  }).catch((e) => console.warn("Recovery comment on breach issue failed:", e.message));
}

async function findOpenBreachIssue() {
  try {
    const issues = await pcFetch(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues` +
      `?q=SLO+breach+summary-coverage&status=todo,in_progress,blocked`,
    );
    const list = Array.isArray(issues) ? issues : issues.issues ?? [];
    return list.find((i) => i.parentId === PARENT_ISSUE_ID) ?? null;
  } catch (e) {
    console.warn("Could not look up open breach issue:", e.message);
    return null;
  }
}

async function main() {
  console.log("SLO: summary-coverage monitor starting…");

  const { total, withSummary, windowStart, graceCutoff, sampledAt } = await sampleCoverage();
  const sampledAtIso = sampledAt.toISOString();

  if (total < MIN_DENOMINATOR) {
    console.log(`Insufficient data: ${total} completed runs in window (< ${MIN_DENOMINATOR}). Skipping alarm decision.`);
    await insertState({
      sampled_at: sampledAtIso,
      coverage: null,
      runs_in_window: total,
      breach: false,
      breach_streak: 0,
      alarm_fired: false,
      note: `insufficient_data (${total} runs)`,
    });
    await trimOldState();
    console.log("Done (insufficient data).");
    return;
  }

  const coverage = withSummary / total;
  const breach = coverage < THRESHOLD;
  const pct = (coverage * 100).toFixed(1);
  console.log(`Coverage: ${pct}% (${withSummary}/${total} runs, window: last 2h, grace 15 min). Breach: ${breach}`);

  const lastState = await getLastState();
  const prevStreak = lastState?.breach_streak ?? 0;
  const prevWasBreachAndAlarmFired = lastState?.breach && lastState?.alarm_fired;
  const breachStreak = breach ? prevStreak + 1 : 0;

  await insertState({
    sampled_at: sampledAtIso,
    coverage: coverage.toFixed(4),
    runs_in_window: total,
    breach,
    breach_streak: breachStreak,
    alarm_fired: false,
    note: null,
  });

  if (breach && breachStreak === BREACH_STREAK_TRIGGER) {
    // First time streak hits the trigger threshold — fire alarm
    console.log(`Breach streak reached ${BREACH_STREAK_TRIGGER}. Firing alarm…`);
    await postBreachComment(coverage, total, breachStreak, windowStart, graceCutoff);
    const breachIssue = await createBreachIssue(coverage, sampledAtIso);
    await markAlarmFired(sampledAtIso);
    console.log(`Alarm fired. Breach issue: ${breachIssue.identifier}`);
  } else if (breach && breachStreak > BREACH_STREAK_TRIGGER && !prevWasBreachAndAlarmFired) {
    // Streak continued past trigger but alarm was never marked — fire now
    console.log(`Late alarm: streak=${breachStreak}, alarm not previously marked. Firing…`);
    await postBreachComment(coverage, total, breachStreak, windowStart, graceCutoff);
    const breachIssue = await createBreachIssue(coverage, sampledAtIso);
    await markAlarmFired(sampledAtIso);
    console.log(`Alarm fired. Breach issue: ${breachIssue.identifier}`);
  } else if (!breach && prevStreak >= BREACH_STREAK_TRIGGER) {
    // Recovery after a breach streak
    console.log(`Recovery detected (prev streak=${prevStreak}). Posting recovery…`);
    const openBreachIssue = await findOpenBreachIssue();
    await postRecoveryComment(coverage, openBreachIssue?.identifier ?? null);
    if (openBreachIssue) {
      await postBreachIssueRecovery(openBreachIssue.id, coverage);
    }
    console.log("Recovery posted.");
  } else if (breach) {
    console.log(`Breach ongoing (streak=${breachStreak}). Alarm threshold: ${BREACH_STREAK_TRIGGER}. Waiting…`);
  } else {
    console.log("Coverage OK. No action needed.");
  }

  await trimOldState();
  console.log("SLO monitor complete.");
}

main().catch((err) => {
  console.error("SLO monitor failed:", err.message);
  process.exitCode = 1;
});
