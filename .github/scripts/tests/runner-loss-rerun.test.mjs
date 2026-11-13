import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyJob, createGithubClient, decide, logShowsRunnerLoss, main, renderSummary,
} from "../runner-loss-rerun.mjs";

// Trimmed attempt-1 snapshots of real PR runs: jobs, check-run annotations for
// each failed job, and the error lines of job logs whose only annotation is
// "The operation was canceled.".
const fixture = (runId) => JSON.parse(readFileSync(
  new URL(`./fixtures/runner-loss-rerun/run-${runId}.json`, import.meta.url), "utf8",
));
const MIXED = 42271918832; // six lost runners, one shutdown in the log, one real test timeout
const REAL = 42264785415; // a real assertion failure
const ALL_LOST = 42272083862; // one lost runner
const LOG_ONLY = 42277969418; // shutdown signal visible only in the job log
const workflow = readFileSync(new URL("../../workflows/ci-runner-loss-rerun.yml", import.meta.url), "utf8");

const json = (body, headers = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json", ...headers },
});

/**
 * Serves a fixture as the GitHub REST API. By default the run is the latest
 * CI for an open PR's current head.
 */
function fakeGithub(data, {
  jobsPageSize = 100, pulls, prRuns, mutateRun = (run) => run,
} = {}) {
  const calls = [];
  const run = mutateRun(structuredClone(data.run));
  const openPr = {
    number: 1, state: "open",
    base: { repo: { id: data.run.repository.id } },
    head: { sha: data.run.head_sha, repo: { id: data.run.head_repository.id } },
  };
  const fetcher = async (href, init) => {
    const url = new URL(href);
    calls.push({ method: init.method, path: url.pathname, query: url.search, auth: init.headers.Authorization });
    const base = `/repos/paperclipai/paperclip`;
    const route = url.pathname.slice(base.length);
    if (init.method === "POST" && route === `/actions/runs/${run.id}/rerun-failed-jobs`) {
      return new Response(null, { status: 201 });
    }
    if (route === `/actions/runs/${run.id}`) return json(run);
    if (route === `/actions/runs/${run.id}/attempts/1/jobs`) {
      const page = Number(url.searchParams.get("page") ?? 1);
      const jobs = data.jobs.slice((page - 1) * jobsPageSize, page * jobsPageSize);
      const last = page * jobsPageSize >= data.jobs.length;
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return json({ total_count: data.total_count, jobs }, last ? {} : { link: `<${next.href}>; rel="next"` });
    }
    let match = route.match(/^\/check-runs\/(\d+)\/annotations$/);
    if (match) return json(data.annotations[match[1]] ?? []);
    match = route.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (match) return new Response(data.logs[match[1]] ?? "", { status: 200 });
    if (route === `/commits/${run.head_sha}/pulls`) return json(pulls ?? [openPr]);
    if (route === "/actions/workflows/pr.yml/runs") {
      const runs = prRuns ?? [{ id: run.id, conclusion: "failure" }];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetcher, run, client: createGithubClient({ token: "test-token", fetcher }) };
}

const posted = (calls) => calls.filter((call) => call.method === "POST");

async function runMain(data, options = {}, eventRun = {}) {
  const github = fakeGithub(data, options);
  const directory = mkdtempSync(path.join(tmpdir(), "runner-loss-rerun-"));
  try {
    const eventPath = path.join(directory, "event.json");
    const summaryPath = path.join(directory, "summary.md");
    writeFileSync(eventPath, JSON.stringify({ workflow_run: { id: data.run.id, run_attempt: 1, ...eventRun } }));
    writeFileSync(summaryPath, "");
    const decision = await main({
      env: { GITHUB_TOKEN: "test-token", GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath },
      argv: [], fetcher: github.fetcher, log: () => {},
    });
    return { decision, calls: github.calls, summary: readFileSync(summaryPath, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("all failed jobs lost their runner: re-runs failed jobs once", async () => {
  const { decision, calls, summary } = await runMain(fixture(ALL_LOST));
  assert.equal(decision.rerun, true);
  assert.deepEqual(decision.jobs.map((job) => [job.name, job.lost]), [["ci / General tests (server (3/12))", true]]);
  assert.deepEqual(posted(calls).map((call) => call.path),
    [`/repos/paperclipai/paperclip/actions/runs/${ALL_LOST}/rerun-failed-jobs`]);
  assert.ok(calls.every((call) => call.auth === "Bearer test-token"));
  // `ci / verify` failed too, but only because its dependency failed.
  assert.equal(calls.some((call) => call.path.endsWith("/check-runs/128088995071/annotations")), false);
  assert.match(summary, /\*\*Re-ran failed jobs\*\*/);
  assert.match(summary, /\| ci \/ General tests \(server \(3\/12\)\) \| yes \| The self-hosted runner lost communication/);
});

test("a shutdown signal found only in the job log counts as runner loss", async () => {
  const data = fixture(LOG_ONLY);
  assert.deepEqual(data.annotations["128101016102"].map((annotation) => annotation.message), ["The operation was canceled."]);
  const { decision, calls } = await runMain(data);
  assert.equal(decision.rerun, true);
  assert.match(decision.jobs[0].evidence, /job log/);
  assert.ok(calls.some((call) => call.path.endsWith("/actions/jobs/128101016102/logs")));
  assert.equal(posted(calls).length, 1);
});

test("mixed runner loss and a real test failure: no re-run", async () => {
  const { decision, calls, summary } = await runMain(fixture(MIXED));
  assert.equal(decision.rerun, false);
  assert.equal(decision.jobs.length, 8);
  assert.deepEqual(decision.jobs.filter((job) => !job.lost).map((job) => job.name), ["ci / General tests (workspaces-a (1/2))"]);
  assert.equal(decision.jobs.find((job) => job.name === "ci / Verify Paperclip Runner (vitest package)").lost, true);
  assert.equal(posted(calls).length, 0);
  assert.match(decision.reason, /1 of 8 failed jobs did not lose their runner/);
  assert.match(summary, /\*\*No automatic re-run\*\*/);
});

test("real test failures: no re-run", async () => {
  const { decision, calls } = await runMain(fixture(REAL));
  assert.equal(decision.rerun, false);
  assert.deepEqual(decision.jobs.map((job) => [job.name, job.lost]), [["ci / General tests (server (4/12))", false]]);
  assert.equal(posted(calls).length, 0);
});

test("only the verify and e2e aggregates failed: no re-run", async () => {
  const data = fixture(ALL_LOST);
  data.jobs = data.jobs.map((job) => job.name.startsWith("ci / General tests") ? { ...job, conclusion: "success" } : job);
  const { decision, calls } = await runMain(data);
  assert.equal(decision.rerun, false);
  assert.match(decision.reason, /no failed jobs other than the verify\/e2e aggregates/);
  assert.equal(calls.some((call) => call.path.includes("/check-runs/")), false);
  assert.equal(posted(calls).length, 0);
});

test("attempt 2 or later is never re-run automatically", async () => {
  // The event was for attempt 1, but someone re-ran the run before this job started.
  const { decision, calls } = await runMain(fixture(ALL_LOST), { mutateRun: (run) => ({ ...run, run_attempt: 2 }) });
  assert.equal(decision.rerun, false);
  assert.match(decision.reason, /attempt 2/);
  assert.deepEqual(calls.map((call) => call.path), [`/repos/paperclipai/paperclip/actions/runs/${ALL_LOST}`]);
});

test("a failed routing gate is left for a human re-run", async () => {
  const data = fixture(ALL_LOST);
  const gate = data.jobs.find((job) => job.name === "ci / gate / Select trusted runner");
  gate.conclusion = "failure";
  data.annotations[gate.id] = [{ annotation_level: "failure", message: "The self-hosted runner lost communication with the server." }];
  const { decision, calls } = await runMain(data);
  assert.equal(decision.rerun, false);
  assert.match(decision.jobs.find((job) => job.id === gate.id).evidence, /routing gate/);
  assert.equal(posted(calls).length, 0);
});

test("runs that are no longer the PR's latest CI are not re-run", async () => {
  const data = fixture(ALL_LOST);
  const moved = await decide(fakeGithub(data, {
    pulls: [{ state: "open", base: { repo: { id: 1170821064 } }, head: { sha: "0".repeat(40), repo: { id: 1170821064 } } }],
  }).client, data.run);
  assert.equal(moved.rerun, false);
  assert.match(moved.reason, /no open pull request/);

  const merged = await decide(fakeGithub(data, {
    pulls: [{ state: "closed", base: { repo: { id: 1170821064 } }, head: { sha: data.run.head_sha, repo: { id: 1170821064 } } }],
  }).client, data.run);
  assert.equal(merged.rerun, false);

  // A later full-ci label run on the same head shares the PR concurrency group;
  // re-running the older run would cancel it.
  const newer = await decide(fakeGithub(data, {
    prRuns: [{ id: data.run.id + 1, conclusion: null }, { id: data.run.id, conclusion: "failure" }],
  }).client, data.run);
  assert.equal(newer.rerun, false);
  assert.match(newer.reason, /newer PR run/);

  // A later label event that did not request CI skips its only job; it is not CI.
  const skipped = await decide(fakeGithub(data, {
    prRuns: [{ id: data.run.id + 1, conclusion: "skipped" }, { id: data.run.id, conclusion: "failure" }],
  }).client, data.run);
  assert.equal(skipped.rerun, true);
});

test("ineligible runs are rejected before any job is read", async () => {
  const data = fixture(ALL_LOST);
  for (const [change, reason] of [
    [{ event: "push" }, /event is push/],
    [{ path: ".github/workflows/other.yml" }, /workflow is/],
    [{ conclusion: "success" }, /completed\/success/],
    [{ repository: { id: 1, full_name: "someone/paperclip" } }, /canonical repository/],
  ]) {
    const github = fakeGithub(data);
    const decision = await decide(github.client, { ...data.run, ...change });
    assert.equal(decision.rerun, false);
    assert.match(decision.reason, reason);
    assert.equal(github.calls.length, 0);
  }
});

test("job listing follows Link pagination across pages", async () => {
  const data = fixture(MIXED);
  const github = fakeGithub(data, { jobsPageSize: 20 });
  const decision = await decide(github.client, data.run);
  const pages = github.calls.filter((call) => call.path.endsWith("/attempts/1/jobs"));
  assert.deepEqual(pages.map((call) => new URLSearchParams(call.query).get("page")), [null, "2", "3"]);
  // Failed jobs on pages 2 and 3 are all classified.
  assert.equal(decision.jobs.length, 8);
  assert.equal(decision.rerun, false);
});

test("an incomplete job listing fails instead of deciding on partial data", async () => {
  const data = fixture(ALL_LOST);
  data.total_count += 1;
  const github = fakeGithub(data);
  await assert.rejects(decide(github.client, data.run), /Incomplete listing/);
  assert.equal(posted(github.calls).length, 0);
});

test("the client refuses to follow pagination to another host", async () => {
  const client = createGithubClient({
    token: "test-token",
    fetcher: async () => json([], { link: '<https://example.com/steal?page=2>; rel="next"' }),
  });
  await assert.rejects(client.paginate("/repos/paperclipai/paperclip/commits/x/pulls"), /Refusing to call https:\/\/example.com/);
});

test("classification is conservative about cancelled jobs", async () => {
  const cancelled = [{ annotation_level: "failure", message: "The operation was canceled." }];
  const noSignal = await classifyJob({ id: 1 }, { annotations: cancelled, readLog: async () => "##[error]The operation was canceled.\n" });
  assert.equal(noSignal.lost, false);
  // A job timeout also cancels the step, but adds its own failure annotation.
  const timedOut = await classifyJob({ id: 1 }, {
    annotations: [{ annotation_level: "failure", message: "The job has exceeded the maximum execution time of 30m0s" }, ...cancelled],
    readLog: async () => { throw new Error("log must not be read"); },
  });
  assert.equal(timedOut.lost, false);
  // Notices and warnings are not failure evidence.
  const warning = await classifyJob({ id: 1 }, {
    annotations: [{ annotation_level: "warning", message: "The self-hosted runner lost communication with the server." }],
    readLog: async () => "",
  });
  assert.equal(warning.lost, false);
  // Test output that merely prints the phrase is not a runner error line.
  assert.equal(logShowsRunnerLoss("2026-11-06T00:00:00Z expected 'received a shutdown signal'\n"), false);
  assert.equal(logShowsRunnerLoss(fixture(MIXED).logs["128078674151"]), true);
});

test("a real failure before the runner was lost is not counted as runner loss", async () => {
  const lostMessage = "The self-hosted runner lost communication with the server. Verify the machine is running.";
  const noLog = async () => { throw new Error("log must not be read"); };
  // A test fails, then the runner is lost during an always() upload step.
  const testThenLost = await classifyJob({ id: 1 }, {
    annotations: [
      { annotation_level: "failure", message: "Error: Test timed out in 15000ms." },
      { annotation_level: "failure", message: "Process completed with exit code 1." },
      { annotation_level: "failure", message: lostMessage },
    ],
    readLog: noLog,
  });
  assert.equal(testThenLost.lost, false);
  assert.match(testThenLost.evidence, /Test timed out/);
  // The order of the annotations does not matter.
  const lostThenExit = await classifyJob({ id: 1 }, {
    annotations: [
      { annotation_level: "failure", message: lostMessage },
      { annotation_level: "failure", message: "Process completed with exit code 1." },
    ],
    readLog: noLog,
  });
  assert.equal(lostThenExit.lost, false);
  // Runner loss with a cancellation only is still runner loss.
  const lostAndCancelled = await classifyJob({ id: 1 }, {
    annotations: [
      { annotation_level: "failure", message: lostMessage },
      { annotation_level: "failure", message: "The operation was canceled." },
    ],
    readLog: noLog,
  });
  assert.equal(lostAndCancelled.lost, true);
});

test("summary cells cannot break the table", () => {
  const summary = renderSummary({
    runId: 1, attempt: 1, rerun: false, reason: "test",
    jobs: [{ name: "ci / a|b", lost: false, evidence: "line one\nline | two" }],
  });
  assert.match(summary, /\| ci \/ a\\\|b \| no \| line one line \\\| two \|/);
});

test("workflow acts only on failed first attempts of the canonical PR workflow", () => {
  const condition = workflow.match(/^ {4}if: >-\n((?: {6}.+\n)+)/m)?.[1].replace(/\s+/g, " ").trim();
  assert.equal(condition, [
    "github.repository == 'paperclipai/paperclip' &&",
    "github.repository_id == '1170821064' &&",
    "github.event.workflow_run.event == 'pull_request' &&",
    "github.event.workflow_run.path == '.github/workflows/pr.yml' &&",
    "github.event.workflow_run.conclusion == 'failure' &&",
    "github.event.workflow_run.run_attempt == 1",
  ].join(" "));
  assert.match(workflow, /^on:\n {2}workflow_run:\n {4}workflows: \[PR\]\n {4}types: \[completed\]$/m);
  assert.match(workflow, /^ {2}group: ci-runner-loss-rerun-\$\{\{ github\.event\.workflow_run\.id \}\}$/m);
  const permissions = workflow.match(/^permissions:\n((?: {2}.+\n)+)/m)[1]
    .split("\n").filter((line) => /^ {2}[a-z-]+:/.test(line)).map((line) => line.trim());
  assert.deepEqual(permissions, ["actions: write", "checks: read", "contents: read", "pull-requests: read"]);
});

test("workflow runs only trusted default-branch code", () => {
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n {10}persist-credentials: false\n {10}sparse-checkout: \.github\/scripts\n/);
  assert.doesNotMatch(workflow, /head_sha|head_branch|download-artifact|secrets\.|pull_request_target/);
  assert.equal([...workflow.matchAll(/uses: /g)].length, 1);
  assert.match(workflow, /runs-on: ubuntu-latest/);
});
