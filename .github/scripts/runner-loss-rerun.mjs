#!/usr/bin/env node
/**
 * runner-loss-rerun.mjs
 *
 * Re-runs the failed jobs of a first PR CI attempt once, but only when every
 * failed or cancelled job ended because its runner was lost. Runs from
 * .github/workflows/ci-runner-loss-rerun.yml on workflow_run. It reads GitHub
 * API metadata only and never touches the PR's code or artifacts.
 *
 * Local dry run against a real run (no rerun is requested):
 *   GITHUB_TOKEN=$(gh auth token) node .github/scripts/runner-loss-rerun.mjs --run-id <id> --dry-run
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "paperclipai/paperclip";
export const REPOSITORY_ID = 1170821064;
export const PR_WORKFLOW_PATH = ".github/workflows/pr.yml";

// The runner's own messages when an AWS instance disappears mid-job.
export const RUNNER_LOSS_PATTERN = /lost communication with the server|received a shutdown signal/;
// `verify` and `e2e` in pr-trusted.yml only assert their `needs` results. They
// fail whenever a dependency failed and re-run with it.
export const AGGREGATE_JOBS = new Set(["ci / verify", "ci / e2e"]);
// ci-routing.yml checks the attempt's triggering actor. A bot-triggered attempt
// would move the whole run to GitHub-hosted runners, so leave it to a human.
export const GATE_JOB_PREFIX = "ci / gate / ";
export const RERUN_CONCLUSIONS = new Set(["failure", "cancelled"]);
// A shutdown signal often reaches the check run only as this annotation; the
// signal itself is logged as an error line in the job log.
const CANCELLED_MESSAGE = "The operation was canceled.";

export function createGithubClient({ token, fetcher = fetch, apiUrl = "https://api.github.com" }) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const origin = new URL(apiUrl).origin;
  const request = async (target, { method = "GET" } = {}) => {
    const url = new URL(target, apiUrl);
    if (url.origin !== origin) throw new Error(`Refusing to call ${url.origin}`);
    const response = await fetcher(url.href, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${url.pathname} failed (HTTP ${response.status})`);
    return response;
  };
  return {
    json: async (target) => (await request(target)).json(),
    // Follows Link rel="next" until the last page. `field` selects the array
    // in wrapped responses such as { total_count, jobs }.
    paginate: async (target, field) => {
      const items = [];
      let totalCount;
      for (let next = target, pages = 0; next; pages += 1) {
        if (pages >= 100) throw new Error(`Too many pages for ${target}`);
        const response = await request(next);
        const body = await response.json();
        const page = field ? body[field] : body;
        if (!Array.isArray(page)) throw new Error(`Unexpected page shape for ${target}`);
        items.push(...page);
        if (field && Number.isInteger(body.total_count)) totalCount = body.total_count;
        next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      }
      if (totalCount !== undefined && items.length !== totalCount) {
        throw new Error(`Incomplete listing for ${target}: ${items.length} of ${totalCount}`);
      }
      return items;
    },
    // Job logs answer with a redirect to a signed download URL.
    text: async (target) => (await request(target)).text(),
    post: async (target) => { await request(target, { method: "POST" }); },
  };
}

export function logShowsRunnerLoss(log) {
  return log.split("\n").some((line) => line.includes("##[error]") && RUNNER_LOSS_PATTERN.test(line));
}

/** Classifies one failed job. Logs are read only when annotations are inconclusive. */
export async function classifyJob(job, { annotations, readLog }) {
  const failures = annotations.filter((annotation) => annotation.annotation_level === "failure");
  const isRunnerLoss = (annotation) => RUNNER_LOSS_PATTERN.test(annotation.message ?? "");
  const match = failures.find(isRunnerLoss);
  if (match) return { lost: true, evidence: firstLine(match.message) };
  if (failures.some((annotation) => annotation.message === CANCELLED_MESSAGE) && logShowsRunnerLoss(await readLog(job))) {
    return { lost: true, evidence: "job log: runner received a shutdown signal or lost communication" };
  }
  const real = failures.find((annotation) => annotation.message !== CANCELLED_MESSAGE);
  if (real) return { lost: false, evidence: firstLine(real.message) };
  if (failures.length > 0) return { lost: false, evidence: `${CANCELLED_MESSAGE} (no runner-loss error in the job log)` };
  return { lost: false, evidence: "no failure annotation" };
}

function firstLine(message) {
  const line = String(message).split("\n")[0];
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function eligibleRun(run) {
  if (run.repository?.full_name !== REPOSITORY || run.repository?.id !== REPOSITORY_ID) return "run is not in the canonical repository";
  if (run.path !== PR_WORKFLOW_PATH) return `workflow is ${run.path}, not ${PR_WORKFLOW_PATH}`;
  if (run.event !== "pull_request") return `event is ${run.event}, not pull_request`;
  if (run.status !== "completed" || !RERUN_CONCLUSIONS.has(run.conclusion)) {
    return `run is ${run.status}/${run.conclusion}, not completed/failure or completed/cancelled`;
  }
  // One automatic re-run only. A higher attempt also means someone re-ran it.
  if (run.run_attempt !== 1) return `run is on attempt ${run.run_attempt}; only attempt 1 is re-run automatically`;
  return undefined;
}

/**
 * Re-running an older run joins the PR's `cancel-in-progress` concurrency
 * group and would cancel newer CI. Require the run to be the latest CI for the
 * PR's current head.
 */
export async function staleReason(client, run) {
  const pulls = await client.paginate(`/repos/${REPOSITORY}/commits/${run.head_sha}/pulls?per_page=100`);
  const open = pulls.filter((pr) => pr.state === "open" && pr.base?.repo?.id === REPOSITORY_ID
    && pr.head?.repo?.id === run.head_repository?.id && pr.head?.sha === run.head_sha);
  if (open.length === 0) return "no open pull request still has this run's head commit";
  const runs = await client.paginate(
    `/repos/${REPOSITORY}/actions/workflows/pr.yml/runs?event=pull_request&head_sha=${run.head_sha}&per_page=100`,
    "workflow_runs",
  );
  const newer = runs.find((candidate) => candidate.id > run.id && candidate.conclusion !== "skipped");
  if (newer) return `a newer PR run (${newer.id}) exists for this head commit`;
  return undefined;
}

export async function decide(client, run) {
  const decision = { runId: run.id, attempt: run.run_attempt, rerun: false, jobs: [] };
  const ineligible = eligibleRun(run);
  if (ineligible) return { ...decision, reason: ineligible };

  const jobs = await client.paginate(`/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`, "jobs");
  const failed = jobs.filter((job) => RERUN_CONCLUSIONS.has(job.conclusion) && !AGGREGATE_JOBS.has(job.name));
  if (failed.length === 0) return { ...decision, reason: "no failed jobs other than the verify/e2e aggregates" };

  const staleBefore = await staleReason(client, run);
  if (staleBefore) return { ...decision, reason: staleBefore };

  for (const job of failed) {
    if (job.name.startsWith(GATE_JOB_PREFIX)) {
      decision.jobs.push({ id: job.id, name: job.name, lost: false, evidence: "routing gate failed; a bot re-run would lose AWS routing" });
      continue;
    }
    const annotations = await client.paginate(`/repos/${REPOSITORY}/check-runs/${job.id}/annotations?per_page=100`);
    const readLog = (entry) => client.text(`/repos/${REPOSITORY}/actions/jobs/${entry.id}/logs`);
    decision.jobs.push({ id: job.id, name: job.name, ...(await classifyJob(job, { annotations, readLog })) });
  }

  const real = decision.jobs.filter((job) => !job.lost);
  if (real.length) return { ...decision, reason: `${real.length} of ${failed.length} failed jobs did not lose their runner` };

  const stale = await staleReason(client, run);
  if (stale) return { ...decision, reason: stale };
  return { ...decision, rerun: true, reason: `all ${failed.length} failed jobs lost their runner` };
}

export function renderSummary(decision, { dryRun = false } = {}) {
  const action = decision.rerun ? (dryRun ? "Would re-run failed jobs (dry run)" : "Re-ran failed jobs") : "No automatic re-run";
  const lines = [
    "### CI runner-loss re-run", "",
    `**${action}** for run ${decision.runId} attempt ${decision.attempt}: ${decision.reason}.`, "",
  ];
  if (decision.jobs.length) {
    lines.push("| Job | Runner lost | Evidence |", "| --- | --- | --- |");
    for (const job of decision.jobs) {
      lines.push(`| ${escapeCell(job.name)} | ${job.lost ? "yes" : "no"} | ${escapeCell(job.evidence)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const escapeCell = (value) => String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export async function main({ env = process.env, argv = process.argv.slice(2), fetcher = fetch, log = console.log } = {}) {
  const dryRun = argv.includes("--dry-run");
  const argRunId = argv[argv.indexOf("--run-id") + 1];
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : undefined;
  const runId = argv.includes("--run-id") ? argRunId : event?.workflow_run?.id;
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error("Provide --run-id or a workflow_run event");
  const client = createGithubClient({ token: env.GITHUB_TOKEN, fetcher });

  // Read the run's current state rather than the event snapshot: its attempt
  // number is above 1 if anyone re-ran it after this event was queued.
  const run = await client.json(`/repos/${REPOSITORY}/actions/runs/${runId}`);
  const decision = await decide(client, run);
  if (decision.rerun && !dryRun) {
    await client.post(`/repos/${REPOSITORY}/actions/runs/${run.id}/rerun-failed-jobs`);
  }
  const summary = renderSummary(decision, { dryRun });
  log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return decision;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
