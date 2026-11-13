import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { classifyAttempt, createRunnerLossRetry, maxRunnerLossAttempt, retryRunnerLoss } from "./cloud-readiness-runner-loss.mjs";
import { waitForSourceVerification } from "./cloud-source-verification.mjs";
import { watchReleaseSource } from "./watch-release-source.mjs";

const sha = "a".repeat(40);
const repository = { id: 1170821064, full_name: "paperclipai/paperclip" };
const lostLog = "2026-11-13T13:49:56.0521573Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.\n";
const testLog = "2026-11-13T14:19:18.2551007Z ##[error]AssertionError: expected \"vi.fn()\" to be called 2 times, but got 1 times\n";
const cancelledNote = { annotation_level: "failure", message: "The operation was canceled." };
const assertionNote = { annotation_level: "failure", message: "AssertionError: expected \"vi.fn()\" to be called 2 times, but got 1 times" };

/**
 * A stateful fake of the GitHub Actions API for one Cloud readiness run. Each
 * attempt is a list of jobs; `rerun-failed-jobs` starts the next attempt from
 * `script`, and `cancel` completes the current one. Job evidence (annotations
 * and logs) is keyed by job id, as GitHub serves it.
 */
function github({ attempts, script = [], startAttempt = 1, status = "completed" }) {
  const state = { attempt: startAttempt, status, attempts: { ...attempts }, writes: [], evidence: {}, script };
  const run = () => ({ id: 99, workflow_id: 123, path: ".github/workflows/cloud-readiness.yml", run_attempt: state.attempt,
    repository, head_repository: repository, head_sha: sha, head_branch: "master", event: "push",
    status: state.status, conclusion: state.status === "completed" ? "failure" : null });
  state.api = async path => {
    if (path.endsWith("/workflows/cloud-readiness.yml")) return { id: 123, path: ".github/workflows/cloud-readiness.yml" };
    if (path.includes("/workflows/123/runs?")) return { total_count: 1, workflow_runs: [run()] };
    const jobs = path.match(/\/runs\/99\/attempts\/(\d+)\/jobs\?/);
    if (jobs) return { total_count: (state.attempts[jobs[1]] ?? []).length, jobs: state.attempts[jobs[1]] ?? [] };
    if (path.endsWith("/runs/99")) return run();
    // The image watcher's own run and the migrator lookup.
    if (path.includes("/runs/50/attempts/1/jobs?")) return { total_count: 0, jobs: [] };
    if (path.endsWith("/runs/50")) return { id: 50, run_attempt: 1, head_sha: sha, head_branch: "master", event: "push",
      repository, head_repository: repository, path: ".github/workflows/docker.yml", status: "in_progress" };
    if (path.endsWith("/workflows/cloud-migrator-artifacts.yml")) return { id: 124, path: ".github/workflows/cloud-migrator-artifacts.yml" };
    if (path.includes("/workflows/124/runs?")) return { total_count: 0, workflow_runs: [] };
    throw new Error(`Unexpected API path: ${path}`);
  };
  const write = async path => {
    state.writes.push(path);
    if (path.endsWith("/cancel")) state.status = "completed";
    if (path.endsWith("/rerun-failed-jobs")) {
      if (state.status !== "completed") throw Object.assign(new Error("HTTP 409"), { status: 409 });
      state.attempt += 1;
      state.attempts[state.attempt] = state.script.shift()?.(state.attempt) ?? [];
      state.status = "in_progress";
    }
  };
  state.cancel = write;
  state.rerunFailed = write;
  state.readAnnotations = async job => state.evidence[job.id]?.annotations ?? [];
  state.readLog = async job => state.evidence[job.id]?.log ?? "";
  state.retry = ({ failure, api }) => retryRunnerLoss({ sha, failure, api, log: () => {}, cancel: path => state.cancel(path),
    rerunFailed: path => state.rerunFailed(path), readAnnotations: job => state.readAnnotations(job), readLog: job => state.readLog(job) });
  state.job = (attempt, id, name, conclusion, evidence) => {
    if (evidence) state.evidence[id] = evidence;
    return { id, name, run_id: 99, run_attempt: attempt, head_sha: sha, status: conclusion ? "completed" : "in_progress", conclusion: conclusion ?? null };
  };
  return state;
}

const proofName = "Cloud source verified v1";

// The 2026-11-13 13:49:56Z reclaim of readiness run 43435593630 attempt 2:
// several jobs lost their Spot runners at once, siblings were cancelled, and
// the source proof was cancelled.
function reclaimedAttempt(g, attempt) {
  return [
    g.job(attempt, attempt * 100 + 1, "verify / Serialized tests (1/5)", "failure", { annotations: [cancelledNote], log: lostLog }),
    g.job(attempt, attempt * 100 + 2, "verify / Verify Paperclip Runner (rust)", "failure", { annotations: [cancelledNote], log: lostLog }),
    g.job(attempt, attempt * 100 + 3, "verify / General tests (server (1/10))", "cancelled", { annotations: [cancelledNote], log: "" }),
    g.job(attempt, attempt * 100 + 4, "verify / Build", "success"),
    g.job(attempt, attempt * 100 + 5, proofName, "cancelled"),
  ];
}
const greenAttempt = g => attempt => [g.job(attempt, attempt * 100 + 4, "verify / Build", "success"), g.job(attempt, attempt * 100 + 5, proofName, "success")];
// A genuine test failure, as in readiness run 43439942063 (decision-models).
const flakyAttempt = g => attempt => [
  g.job(attempt, attempt * 100 + 1, "verify / General tests (server (4/10))", "failure", { annotations: [assertionNote], log: testLog }),
  g.job(attempt, attempt * 100 + 3, "verify / General tests (server (1/10))", "cancelled", { annotations: [cancelledNote] }),
  g.job(attempt, attempt * 100 + 5, proofName, "cancelled"),
];

const clock = () => { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; };

describe("runner-loss classification", () => {
  test("an attempt whose every failed job lost its runner is a runner loss; cancelled siblings are fallout", async () => {
    const g = github({ attempts: {} });
    const verdict = await classifyAttempt(reclaimedAttempt(g, 2), g);
    assert.equal(verdict.lost, true);
    assert.deepEqual(verdict.jobs.map(job => job.conclusion), ["failure", "failure"]);
  });

  test("one real failure beside lost runners is not a runner loss", async () => {
    const g = github({ attempts: {} });
    const jobs = [...reclaimedAttempt(g, 2), ...flakyAttempt(g)(2).slice(0, 1)];
    assert.equal((await classifyAttempt(jobs, g)).lost, false);
  });

  test("a failing test is not a runner loss", async () => {
    const g = github({ attempts: {} });
    assert.equal((await classifyAttempt(flakyAttempt(g)(2), g)).lost, false);
  });

  test("a reclaimed job that concluded cancelled counts only with a runner-loss log", async () => {
    const g = github({ attempts: {} });
    const lost = [g.job(2, 1, "verify / Build", "cancelled", { annotations: [cancelledNote], log: lostLog }), g.job(2, 2, proofName, "cancelled")];
    assert.equal((await classifyAttempt(lost, g)).lost, true);
    // A person cancelling the run is not a runner loss.
    const manual = [g.job(2, 3, "verify / Build", "cancelled", { annotations: [cancelledNote, { annotation_level: "failure", message: "The run was canceled by @someone." }] }), g.job(2, 4, proofName, "cancelled")];
    assert.equal((await classifyAttempt(manual, g)).lost, false);
  });

  test("non-gating Runner chaos evals neither cause nor block a retry", async () => {
    const g = github({ attempts: {} });
    const chaos = g.job(2, 9, "Runner chaos evals (not a publication gate) / Restart, replay, trace, and recovery faults", "failure", { annotations: [assertionNote], log: testLog });
    assert.equal((await classifyAttempt([...reclaimedAttempt(g, 2), chaos], g)).lost, true);
  });

  test("unreadable job evidence fails closed", async () => {
    const g = github({ attempts: {} });
    const verdict = await classifyAttempt(reclaimedAttempt(g, 2), { ...g, readLog: async () => { throw new Error("HTTP 404"); } });
    assert.equal(verdict.lost, false);
  });
});

describe("runner-loss retry", () => {
  test("a completed reclaimed attempt re-runs only its failed jobs", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.deepEqual(g.writes, ["/repos/paperclipai/paperclip/actions/runs/99/rerun-failed-jobs"]);
  });

  test("a reclaimed attempt still running is ended first, then re-run on the next poll", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = reclaimedAttempt(g, 2);
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.deepEqual(g.writes, ["/repos/paperclipai/paperclip/actions/runs/99/cancel"]);
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.equal(g.writes.at(-1), "/repos/paperclipai/paperclip/actions/runs/99/rerun-failed-jobs");
  });

  test("a newer attempt started while evidence was read is never cancelled", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = reclaimedAttempt(g, 2);
    const readLog = g.readLog;
    // The other waiter ends attempt 2 and starts attempt 3 during our log read.
    g.readLog = async job => { g.attempt = 3; g.status = "in_progress"; return readLog(job); };
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.deepEqual(g.writes, []);
  });

  test("a cancellation conflict after the attempt completed keeps waiting", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.cancel = async () => { g.status = "completed"; throw Object.assign(new Error("HTTP 409"), { status: 409 }); };
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
  });

  test("an unexpected cancellation error with the attempt still running is surfaced", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.cancel = async () => { throw Object.assign(new Error("HTTP 500"), { status: 500 }); };
    await assert.rejects(g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), /HTTP 500/);
  });

  test("a real failure is never retried", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = flakyAttempt(g)(2);
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "failed");
    assert.deepEqual(g.writes, []);
  });

  test("retries stop at the attempt ceiling", async () => {
    const g = github({ attempts: {}, startAttempt: maxRunnerLossAttempt });
    g.attempts[maxRunnerLossAttempt] = reclaimedAttempt(g, maxRunnerLossAttempt);
    assert.equal(await g.retry({ failure: { runId: 99, attempt: maxRunnerLossAttempt }, api: g.api }), "failed");
    assert.deepEqual(g.writes, []);
  });

  test("a newer attempt started by the other waiter or a person is waited on, not re-run", async () => {
    const g = github({ attempts: {}, startAttempt: 3, status: "in_progress" });
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.deepEqual(g.writes, []);
  });

  test("the other waiter winning the same re-run is not a failure", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.rerunFailed = async () => { g.attempt += 1; g.status = "in_progress"; throw Object.assign(new Error("HTTP 403"), { status: 403 }); };
    assert.equal(await g.retry({ failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
  });

  test("a changed run identity refuses to write", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    await assert.rejects(retryRunnerLoss({ sha: "b".repeat(40), failure: { runId: 99, attempt: 2 }, api: g.api, log: () => {},
      cancel: g.cancel, rerunFailed: g.rerunFailed, readAnnotations: g.readAnnotations, readLog: g.readLog }), /identity changed/);
    assert.deepEqual(g.writes, []);
  });

  test("every waiter job that may retry can read runner-loss evidence", async () => {
    const { readFileSync } = await import("node:fs");
    const read = file => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const job = (text, name) => text.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z_-]+:\\n)`))[0];
    for (const [file, name] of [["release.yml", "verify_canary"], ["docker.yml", "source_verification"], ["docker.yml", "publication_verification"]]) {
      const text = job(read(file), name);
      assert.match(text, /\n      checks: read\b/, `${file} ${name} needs checks: read for annotations`);
      assert.match(text, /\n      actions: write\b/, `${file} ${name} needs actions: write for logs and retries`);
    }
  });

  test("the production writer only posts cancel or rerun-failed-jobs to a canonical run", async () => {
    const posts = [];
    const fetcher = async (url, init) => { posts.push([url, init.method]); return new Response(null, { status: 201 }); };
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    const evidence = async url => url.includes("/annotations") ? Response.json([cancelledNote]) : new Response(lostLog);
    const retry = createRunnerLossRetry({ token: "t", log: () => {}, fetcher: async (url, init = {}) => init.method === "POST" ? fetcher(url, init) : evidence(url) });
    assert.equal(await retry({ sha, failure: { runId: 99, attempt: 2 }, api: g.api }), "retrying");
    assert.deepEqual(posts, [["https://api.github.com/repos/paperclipai/paperclip/actions/runs/99/rerun-failed-jobs", "POST"]]);
  });
});

// Simulations of the 2026-11-13 hold: readiness attempt 2 loses its runners.
// Before this change both waiters failed the release on that attempt.
describe("busy-master simulation", () => {
  test("the npm canary gate retries a reclaimed attempt and publishes on the retried proof", async () => {
    const g = github({ attempts: {}, startAttempt: 2, script: [] });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.script.push(greenAttempt(g));
    const proof = await waitForSourceVerification(sha, { api: g.api, ...clock(), log: () => {}, retryRunnerLoss: g.retry });
    assert.deepEqual({ runId: proof.runId, attempt: proof.attempt }, { runId: 99, attempt: 3 });
    assert.deepEqual(g.writes, ["/repos/paperclipai/paperclip/actions/runs/99/rerun-failed-jobs"]);
  });

  test("without the retry the same reclaim fails the release (the 2026-11-13 behavior)", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    await assert.rejects(waitForSourceVerification(sha, { api: g.api, ...clock(), log: () => {} }), /did not pass/);
  });

  test("two reclaims in a row still publish; a third stops at the ceiling", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.script.push(attempt => reclaimedAttempt(g, attempt), greenAttempt(g));
    const proof = await waitForSourceVerification(sha, { api: g.api, ...clock(), log: () => {}, retryRunnerLoss: g.retry });
    assert.equal(proof.attempt, 4);

    const h = github({ attempts: {}, startAttempt: 2 });
    h.attempts[2] = reclaimedAttempt(h, 2);
    h.script.push(attempt => reclaimedAttempt(h, attempt), attempt => reclaimedAttempt(h, attempt));
    await assert.rejects(waitForSourceVerification(sha, { api: h.api, ...clock(), log: () => {}, retryRunnerLoss: h.retry }), /attempt 4/);
  });

  test("a real test failure still fails the release without a retry", async () => {
    const g = github({ attempts: {}, startAttempt: 2 });
    g.attempts[2] = flakyAttempt(g)(2);
    await assert.rejects(waitForSourceVerification(sha, { api: g.api, ...clock(), log: () => {}, retryRunnerLoss: g.retry }), /did not pass/);
    assert.deepEqual(g.writes, []);
  });

  test("the image watcher keeps its image attempt alive through a reclaim instead of cancelling it", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = reclaimedAttempt(g, 2);
    g.script.push(greenAttempt(g));
    const imageCancels = [];
    const proof = await watchReleaseSource({ sha, runId: 50, attempt: 1, api: g.api, ...clock(), log: () => {},
      cancel: async path => imageCancels.push(path), retryRunnerLoss: g.retry });
    assert.equal(proof.attempt, 3);
    assert.deepEqual(imageCancels, []);
    assert.deepEqual(g.writes, ["/repos/paperclipai/paperclip/actions/runs/99/cancel", "/repos/paperclipai/paperclip/actions/runs/99/rerun-failed-jobs"]);
  });

  test("the image watcher still cancels image work on a real failure", async () => {
    const g = github({ attempts: {}, startAttempt: 2, status: "in_progress" });
    g.attempts[2] = flakyAttempt(g)(2);
    const imageCancels = [];
    await assert.rejects(watchReleaseSource({ sha, runId: 50, attempt: 1, api: g.api, ...clock(), log: () => {},
      cancel: async path => imageCancels.push(path), retryRunnerLoss: g.retry }), /General tests/);
    assert.deepEqual(imageCancels, ["/repos/paperclipai/paperclip/actions/runs/99/cancel", "/repos/paperclipai/paperclip/actions/runs/50/cancel"]);
  });
});
