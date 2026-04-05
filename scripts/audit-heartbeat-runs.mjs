#!/usr/bin/env node
/**
 * Samples heartbeat runs per agent and prints aggregates (status, error_code, adapter_type).
 * Uses the board API — same auth model as audit-agent-models.mjs.
 *
 * Usage:
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/audit-heartbeat-runs.mjs
 *   PAPERCLIP_COMPANY_ID=<uuid> PAPERCLIP_TOKEN=<bearer> node scripts/audit-heartbeat-runs.mjs --json
 *
 * Env:
 *   PAPERCLIP_URL — default http://127.0.0.1:3100
 *   PAPERCLIP_TOKEN — optional Bearer for authenticated board API
 *   AUDIT_RUNS_LIMIT — max rows for company-wide list (default 500, max 1000)
 *   AGENT_SAMPLE_LIMIT — per-agent sample size (default 30, max 200)
 *   AUDIT_DAYS — only include runs with createdAt within this many days (default 7, 0 = all)
 *   STUCK_RUNNING_MS — flag running runs whose startedAt is older than this (default 7200000 = 2h)
 *
 * @see doc/plans/2026-04-03-heartbeat-runs-sampling-and-triage.md for SQL equivalents and P0/P1 triage.
 */

const baseUrl = (process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
const asJson = process.argv.includes("--json");

const auditRunsLimit = Math.min(
  1000,
  Math.max(1, parseInt(process.env.AUDIT_RUNS_LIMIT ?? "500", 10) || 500),
);
const agentSampleLimit = Math.min(
  200,
  Math.max(1, parseInt(process.env.AGENT_SAMPLE_LIMIT ?? "30", 10) || 30),
);
const auditDays = Math.max(0, parseInt(process.env.AUDIT_DAYS ?? "7", 10) || 7);
const stuckRunningMs = Math.max(
  0,
  parseInt(process.env.STUCK_RUNNING_MS ?? String(2 * 60 * 60 * 1000), 10) || 2 * 60 * 60 * 1000,
);

function authHeaders() {
  const headers = { Accept: "application/json" };
  const token = process.env.PAPERCLIP_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function toDate(value) {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function withinWindow(createdAt, cutoffMs) {
  if (cutoffMs == null) return true;
  const d = toDate(createdAt);
  if (!d) return true;
  return d.getTime() >= cutoffMs;
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printTable(title, rows) {
  console.log(`\n## ${title}`);
  for (const [k, v] of rows) {
    console.log(`${v}\t${k}`);
  }
}

async function main() {
  if (!companyId) {
    console.error("Missing PAPERCLIP_COMPANY_ID.");
    process.exit(1);
  }

  const cutoffMs = auditDays > 0 ? Date.now() - auditDays * 24 * 60 * 60 * 1000 : null;

  const agentsRes = await fetch(`${baseUrl}/api/companies/${companyId}/agents`, { headers: authHeaders() });
  if (!agentsRes.ok) {
    console.error(`GET agents -> ${agentsRes.status}`, (await agentsRes.text()).slice(0, 400));
    process.exit(1);
  }
  const agents = await agentsRes.json();
  if (!Array.isArray(agents)) {
    console.error("Expected agents array");
    process.exit(1);
  }

  const agentById = new Map(agents.map((a) => [a.id, a]));

  const globalRes = await fetch(
    `${baseUrl}/api/companies/${companyId}/heartbeat-runs?limit=${auditRunsLimit}`,
    { headers: authHeaders() },
  );
  if (!globalRes.ok) {
    console.error(`GET heartbeat-runs -> ${globalRes.status}`, (await globalRes.text()).slice(0, 400));
    process.exit(1);
  }
  const globalRuns = await globalRes.json();
  if (!Array.isArray(globalRuns)) {
    console.error("Expected heartbeat-runs array");
    process.exit(1);
  }

  const filteredGlobal = globalRuns.filter((r) => withinWindow(r.createdAt, cutoffMs));

  const byStatus = new Map();
  const byErrorCode = new Map();
  const byAdapterStatus = new Map();
  const byAdapterError = new Map();

  for (const run of filteredGlobal) {
    const agent = agentById.get(run.agentId);
    const adapter = agent?.adapterType ?? "unknown";
    bump(byStatus, run.status ?? "null");
    const ec = run.errorCode ?? "(none)";
    bump(byErrorCode, ec);
    bump(byAdapterStatus, `${adapter}\t${run.status ?? "null"}`);
    if (run.status === "failed" || run.status === "timed_out") {
      bump(byAdapterError, `${adapter}\t${ec}`);
    }
  }

  const stuck = [];
  const now = Date.now();
  for (const run of filteredGlobal) {
    if (run.status !== "running") continue;
    const started = toDate(run.startedAt);
    if (started && stuckRunningMs > 0 && now - started.getTime() > stuckRunningMs) {
      const agent = agentById.get(run.agentId);
      stuck.push({
        runId: run.id,
        agentId: run.agentId,
        agentName: agent?.name,
        adapterType: agent?.adapterType,
        startedAt: run.startedAt,
        ageMs: now - started.getTime(),
      });
    }
  }

  const perAgent = [];
  for (const agent of agents) {
    const rRes = await fetch(
      `${baseUrl}/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agent.id)}&limit=${agentSampleLimit}`,
      { headers: authHeaders() },
    );
    if (!rRes.ok) {
      console.error(`GET heartbeat-runs agent=${agent.id} -> ${rRes.status}`);
      process.exit(1);
    }
    const runs = await rRes.json();
    const sample = Array.isArray(runs) ? runs.filter((r) => withinWindow(r.createdAt, cutoffMs)) : [];
    const fail = sample.filter((r) => r.status === "failed" || r.status === "timed_out");
    const lastFail = fail[0] ?? null;
    perAgent.push({
      agentId: agent.id,
      name: agent.name,
      adapterType: agent.adapterType,
      sampleSize: sample.length,
      failedInSample: fail.length,
      lastFailure: lastFail
        ? {
            runId: lastFail.id,
            status: lastFail.status,
            errorCode: lastFail.errorCode,
            finishedAt: lastFail.finishedAt,
          }
        : null,
    });
  }

  const payload = {
    companyId,
    windowDays: auditDays,
    globalFetchLimit: auditRunsLimit,
    globalMatchingRuns: filteredGlobal.length,
    aggregates: {
      byStatus: Object.fromEntries(byStatus),
      byErrorCode: Object.fromEntries(byErrorCode),
      byAdapterStatus: Object.fromEntries(byAdapterStatus),
      byAdapterError: Object.fromEntries(byAdapterError),
    },
    stuckRunning: stuck,
    perAgentSampleLimit: agentSampleLimit,
    perAgent,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Heartbeat run audit — company ${companyId}`);
  console.log(`Window: last ${auditDays || "∞"} days | company fetch limit ${auditRunsLimit} | matching ${filteredGlobal.length} runs`);
  printTable(
    "Counts by status",
    [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
  );
  printTable(
    "Counts by error_code (all statuses)",
    [...byErrorCode.entries()].sort((a, b) => b[1] - a[1]),
  );
  printTable(
    "Failed/timed_out by adapter + error_code",
    [...byAdapterError.entries()].sort((a, b) => b[1] - a[1]),
  );

  if (stuck.length > 0) {
    console.log("\n## Possibly stuck running runs (started > STUCK_RUNNING_MS ago)");
    for (const s of stuck) {
      console.log(
        `${s.runId}\t${s.agentName ?? s.agentId}\t${s.adapterType ?? ""}\tstarted ${s.startedAt}\t${Math.round(s.ageMs / 60000)}m`,
      );
    }
  } else {
    console.log("\n## No long-running `running` rows in this sample (or STUCK_RUNNING_MS=0).");
  }

  console.log("\n## Per-agent sample (latest N per agent)");
  for (const row of perAgent) {
    const lf = row.lastFailure
      ? `${row.lastFailure.status} ${row.lastFailure.errorCode ?? ""} ${row.lastFailure.runId}`
      : "—";
    console.log(`${row.name}\t${row.adapterType}\tsample ${row.sampleSize}\tfailed ${row.failedInSample}\tlast fail: ${lf}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
