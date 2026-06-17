#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    requireClean: false,
    healthUrl: process.env.PAPERCLIP_HEALTH_URL ?? "http://127.0.0.1:3100/api/health",
    liveRunsUrl: process.env.PAPERCLIP_LIVE_RUNS_URL ?? "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-clean") {
      args.requireClean = true;
      continue;
    }
    if (arg === "--health-url") {
      args.healthUrl = argv[++i] ?? "";
      continue;
    }
    if (arg === "--live-runs-url") {
      args.liveRunsUrl = argv[++i] ?? "";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "usage: node scripts/approval-evidence-report.mjs [--require-clean] [--health-url <url>] [--live-runs-url <url>]",
    "",
    "Prints machine-verifiable evidence for merge/deploy/runtime approval requests.",
    "Does not print secrets or environment variables.",
  ].join("\n");
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    if (options.optional) return "";
    throw error;
  }
}

async function fetchJson(url) {
  if (!url) return null;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return { ok: false, status: response.status, statusText: response.statusText };
  }
  const json = await response.json();
  return { ok: true, status: response.status, body: json };
}

function summarizeLiveRuns(response) {
  if (!response?.ok || !Array.isArray(response.body)) return response;
  const counts = response.body.reduce((acc, run) => {
    const status = typeof run?.status === "string" ? run.status : "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  return {
    ...response,
    runningObserved: counts.running ?? 0,
    queuedObserved: counts.queued ?? 0,
    statusCounts: counts,
  };
}

function parseAheadBehind(output) {
  const [behind = "0", ahead = "0"] = output.split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

function trackedDirtyFiles() {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=no"]);
  return status ? status.split("\n") : [];
}

function changedFiles() {
  const diff = run("git", ["diff", "--name-status", "HEAD"], { optional: true });
  return diff ? diff.split("\n") : [];
}

function systemctlShow(unit, properties) {
  const output = run("systemctl", ["show", unit, `--property=${properties.join(",")}`, "--no-pager"], { optional: true });
  if (!output) return null;
  const result = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const branch = run("git", ["branch", "--show-current"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { optional: true });
  const upstreamHead = upstream ? run("git", ["rev-parse", upstream], { optional: true }) : "";
  const aheadBehind = upstream ? parseAheadBehind(run("git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])) : null;
  const dirtyTracked = trackedDirtyFiles();
  const changed = changedFiles();
  const health = await fetchJson(args.healthUrl);
  const liveRuns = summarizeLiveRuns(await fetchJson(args.liveRunsUrl));

  const report = {
    schemaVersion: 1,
    kind: "paperclip.approval_evidence",
    capturedAt: new Date().toISOString(),
    git: {
      branch,
      head,
      upstream: upstream || null,
      upstreamHead: upstreamHead || null,
      aheadBehind,
      trackedWorkingTreeClean: dirtyTracked.length === 0,
      dirtyTrackedFiles: dirtyTracked,
      changedFiles: changed,
    },
    runtime: {
      paperclipService: systemctlShow("paperclip.service", [
        "ActiveState",
        "SubState",
        "MainPID",
        "NRestarts",
        "ExecStart",
        "WorkingDirectory",
      ]),
      health,
      liveRuns,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (args.requireClean && dirtyTracked.length > 0) {
    console.error("approval evidence failed: tracked working tree is not clean");
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
