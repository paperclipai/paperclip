#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  ghJson,
  isTerminalIssue,
  normalizeCheck,
  normalizeRepository,
  parseArgs,
  readJson,
  reason,
  writeJson,
} from "./lib.mjs";

function assessChecks(contexts) {
  const checks = contexts.map(normalizeCheck);
  return {
    checks,
    pending: checks.filter((check) => check.pending),
    failing: checks.filter((check) => !check.pending && !check.green),
    allGreen: checks.length > 0 && checks.every((check) => check.green),
  };
}

function assessGreptile(checkRuns) {
  const runs = checkRuns.filter((run) => /greptile/i.test(run.name));
  const completed = runs.filter((run) => run.status === "completed");
  const clean = completed.filter((run) => run.conclusion === "success" || run.conclusion === "neutral");
  const blocking = completed.filter((run) => run.conclusion !== "success" && run.conclusion !== "neutral");
  return {
    present: runs.length > 0,
    pending: runs.some((run) => run.status !== "completed"),
    clean: clean.length > 0 && blocking.length === 0,
    runs: runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url ?? null,
    })),
  };
}

function fetchCheckRuns(repository, headSha) {
  const runs = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = ghJson([
      "api",
      `repos/${repository}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    ]);
    const pageRuns = response.check_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) return runs;
  }
  throw new Error(`Check-run pagination exceeded 100 pages for ${headSha}`);
}

export function readinessVerdict({ pullRequest, checks, greptile, behindBy, originatingIssue }) {
  const reasons = [];
  if (pullRequest.state !== "OPEN") reasons.push(reason("pr_not_open", `PR is ${pullRequest.state.toLowerCase()}`));
  const mergeable = pullRequest.mergeable ?? "UNKNOWN";
  if (mergeable === "CONFLICTING") reasons.push(reason("merge_conflict", "GitHub reports merge conflicts"));
  if (mergeable === "UNKNOWN") reasons.push(reason("mergeability_unknown", "GitHub has not resolved mergeability"));
  if (checks.pending.length > 0) {
    reasons.push(reason("checks_pending", `${checks.pending.length} check(s) are pending`, "blocking", { names: checks.pending.map((check) => check.name) }));
  }
  if (checks.failing.length > 0) {
    reasons.push(reason("checks_failing", `${checks.failing.length} check(s) are not green`, "blocking", { names: checks.failing.map((check) => check.name) }));
  }
  if (checks.checks.length === 0) reasons.push(reason("checks_missing", "No status checks were found at the current head"));
  if (!greptile.present) reasons.push(reason("greptile_missing", "No Greptile check-run exists at the current head"));
  else if (greptile.pending) reasons.push(reason("greptile_pending", "Greptile has not completed at the current head"));
  else if (!greptile.clean) reasons.push(reason("greptile_not_clean", "Greptile did not conclude success or neutral at the current head"));
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") reasons.push(reason("changes_requested", "A review requests changes"));
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") reasons.push(reason("review_required", "Required review approval is missing"));
  if (behindBy > 0) reasons.push(reason("base_behind", `Head is ${behindBy} commit(s) behind base`, "blocking", { behindBy }));
  if (!originatingIssue) reasons.push(reason("originating_issue_missing", "No originating Paperclip issue was identified", "reporting"));
  else if (!isTerminalIssue(originatingIssue.status)) {
    reasons.push(reason("originating_issue_active", `Originating issue ${originatingIssue.identifier ?? originatingIssue.issueId} is ${originatingIssue.status}`, "reporting"));
  }

  if (pullRequest.isDraft) return { verdict: "report_only", reasons };
  return { verdict: reasons.some((entry) => entry.severity === "blocking") ? "needs_gardening" : "ready", reasons };
}

export function confidenceFor(entry) {
  if (entry.verdict === "report_only") return "low";
  const codes = new Set(entry.reasons.map((entryReason) => entryReason.code));
  const lowConfidenceCodes = [
    "originating_issue_missing",
    "greptile_missing",
    "greptile_pending",
    "greptile_not_clean",
    "checks_missing",
    "checks_failing",
    "checks_pending",
    "merge_conflict",
    "mergeability_unknown",
    "changes_requested",
  ];
  if (lowConfidenceCodes.some((code) => codes.has(code))) {
    return "low";
  }
  if (entry.verdict === "ready" && !codes.has("originating_issue_active")) return "high";
  return "medium";
}

export async function checkReadiness(candidatesDocument, options = {}) {
  const repository = normalizeRepository(options.repo ?? candidatesDocument.repository);
  const results = [];
  for (const candidate of candidatesDocument.candidates) {
    const pullRequest = ghJson([
      "pr",
      "view",
      String(candidate.number),
      "--repo",
      repository,
      "--json",
      "number,url,title,state,isDraft,headRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt",
    ]);
    const checkRuns = fetchCheckRuns(repository, pullRequest.headRefOid);
    const comparison = ghJson([
      "api",
      `repos/${repository}/compare/${encodeURIComponent(pullRequest.baseRefName)}...${encodeURIComponent(pullRequest.headRefOid)}`,
    ]);
    const checks = assessChecks(pullRequest.statusCheckRollup ?? []);
    const greptile = assessGreptile(checkRuns);
    const assessment = readinessVerdict({
      pullRequest,
      checks,
      greptile,
      behindBy: comparison.behind_by ?? 0,
      originatingIssue: candidate.originatingIssue,
    });
    const entry = {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      mergeable: (pullRequest.mergeable ?? "UNKNOWN").toLowerCase(),
      mergeStateStatus: (pullRequest.mergeStateStatus ?? "UNKNOWN").toLowerCase(),
      reviewDecision: pullRequest.reviewDecision || null,
      behindBy: comparison.behind_by ?? 0,
      checks,
      greptile,
      originatingIssue: candidate.originatingIssue,
      sourceIssues: candidate.sourceIssues,
      ...assessment,
    };
    entry.confidence = confidenceFor(entry);
    results.push(entry);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    candidatesGeneratedAt: candidatesDocument.generatedAt,
    dryRun: Boolean(options.dry_run ?? candidatesDocument.dryRun),
    summary: {
      total: results.length,
      ready: results.filter((entry) => entry.verdict === "ready").length,
      needsGardening: results.filter((entry) => entry.verdict === "needs_gardening").length,
      reportOnly: results.filter((entry) => entry.verdict === "report_only").length,
    },
    pullRequests: results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { input: "candidates.json", output: "readiness.json" });
  writeJson(options.output, await checkReadiness(readJson(options.input), options));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
