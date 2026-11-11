import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionsReader, readSourceVerification, sourceVerificationJob, waitForSourceVerification, SourceVerificationDeferred } from "./cloud-source-verification.mjs";

import { releaseAdmitted, deferredProducer, requestDeferredProducer, readMigratorPublication, sourceAdmissionJob, migratorAdmissionJob, createReleaseRerunner } from "./cloud-release-admission.mjs";

import { cancelImageRun, runnerWaits, watchReleaseSource } from "./watch-release-source.mjs";

const sha = "a".repeat(40);

function runAdmissionCli({ active = false, imageOnly = false, repositoryName = "paperclipai/paperclip" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-admission-cli-"));
  try {
    const preload = join(root, "github-fixture.mjs");
    const installFixture = (active) => {
      const repository = { id: 1170821064, full_name: "paperclipai/paperclip" };
      const run = { id: 77, workflow_id: 21, path: ".github/workflows/docker.yml", head_sha: "a".repeat(40),
        repository, head_repository: repository, head_branch: "master", event: "push", run_attempt: 1, status: "in_progress" };
      globalThis.fetch = async url => {
        const parsed = new URL(url);
        if (parsed.origin !== "https://api.github.com") throw new Error("Unexpected admission request origin");
        const path = parsed.pathname;
        if (path.endsWith("/docker.yml")) return Response.json({ id: 21, path: ".github/workflows/docker.yml" });
        if (path.endsWith("/release.yml")) return Response.json({ id: 22, path: ".github/workflows/release.yml" });
        if (path.endsWith("/workflows/21/runs")) return Response.json({ total_count: active ? 1 : 0, workflow_runs: active ? [run] : [] });
        if (path.endsWith("/workflows/22/runs")) return Response.json({ total_count: 0, workflow_runs: [] });
        if (path.endsWith("/runs/77")) return Response.json(run);
        throw new Error("Unexpected admission request path");
      };
    };
    writeFileSync(preload, "(" + installFixture.toString() + ")(" + JSON.stringify(active) + ");\n");
    const output = join(root, "output");
    const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("./cloud-release-admission.mjs", import.meta.url)), ...(imageOnly ? ["image-only"] : [])], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, GITHUB_REPOSITORY: repositoryName, GITHUB_REF: "refs/heads/master", GITHUB_SHA: "a".repeat(40),
        GITHUB_EVENT_NAME: "push", GITHUB_RUN_ATTEMPT: "1", GITHUB_TOKEN: "fixture", GITHUB_OUTPUT: output },
    });
    return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("admission CLI startup", () => {
  for (const imageOnly of [false, true]) {
    for (const active of [false, true]) {
      test("executes " + (imageOnly ? "image-only" : "source") + " admission with active consumer=" + active, () => {
        const result = runAdmissionCli({ active, imageOnly });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.equal(result.output, "admitted=" + active + "\n");
      });
    }
  }
  test("rejects a noncanonical CLI context before discovering consumers", () => {
    const result = runAdmissionCli({ repositoryName: "fork/paperclip" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Canonical master admission context required/);
    assert.equal(result.output, "");
  });
});

test("the final image publication CLI rejects a green workflow that skipped its migrator", () => {
  const root = mkdtempSync(join(tmpdir(), "migrator-publication-cli-"));
  try {
    const preload = join(root, "fixture.mjs");
    const installFixture = () => {
      const repository = { id: 1170821064, full_name: "paperclipai/paperclip" };
      const run = (id, file) => ({ id, workflow_id: id, run_attempt: 1, path: `.github/workflows/${file}`, event: "push",
        head_branch: "master", head_sha: "a".repeat(40), repository, head_repository: repository, status: "completed", conclusion: "success" });
      const source = run(1, "cloud-readiness.yml"), migrator = run(2, "cloud-migrator-artifacts.yml");
      globalThis.fetch = async (input, init) => {
        if (init?.method && init.method !== "GET") throw new Error("Final publication must be read-only");
        const url = new URL(input), path = url.pathname;
        if (url.origin !== "https://api.github.com") throw new Error("Unexpected origin");
        if (path.endsWith("/cloud-readiness.yml")) return Response.json({ id: 1, path: source.path });
        if (path.endsWith("/cloud-migrator-artifacts.yml")) return Response.json({ id: 2, path: migrator.path });
        if (path.endsWith("/workflows/1/runs")) return Response.json({ total_count: 1, workflow_runs: [source] });
        if (path.endsWith("/workflows/2/runs")) return Response.json({ total_count: 1, workflow_runs: [migrator] });
        if (path.endsWith("/runs/1")) return Response.json(source);
        if (path.endsWith("/runs/2")) return Response.json(migrator);
        if (path.endsWith("/jobs")) {
          const id = path.includes("/runs/1/") ? 1 : 2;
          return Response.json({ total_count: 1, jobs: [{ id: 3, name: id === 1 ? "Cloud source verified v1" : "publish",
            run_id: id, run_attempt: 1, head_sha: "a".repeat(40), status: "completed",
            conclusion: id === 1 || process.env.FIXTURE_PUBLISHED === "1" ? "success" : "skipped" }] });
        }
        throw new Error(`Unexpected path ${path}`);
      };
    };
    writeFileSync(preload, "(" + installFixture.toString() + ")();\n");
    for (const published of [false, true]) {
      const output = join(root, `output-${published}`);
      const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("./watch-release-source.mjs", import.meta.url)), "--check-proof"], {
        encoding: "utf8", timeout: 5_000, env: { ...process.env, GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master",
          GITHUB_SHA: sha, GITHUB_TOKEN: "fixture", GITHUB_OUTPUT: output, FIXTURE_PUBLISHED: published ? "1" : "0" },
      });
      assert.equal(result.status, published ? 0 : 1, result.stderr || result.error?.message);
      if (published) assert.equal(readFileSync(output, "utf8"), "verified=true\n");
      else assert.match(result.stderr, /Exact-source migrator has not published/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const workflow = { id: 123, path: ".github/workflows/cloud-readiness.yml" };
const baseRun = {
  id: 456, workflow_id: workflow.id, path: workflow.path, run_attempt: 2,
  repository: { full_name: "paperclipai/paperclip" }, head_repository: { full_name: "paperclipai/paperclip" },
  head_sha: sha, head_branch: "master", event: "push", status: "in_progress", conclusion: null,
};
const baseJob = { id: 789, name: sourceVerificationJob, run_id: 456, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "success" };

function fixture({ runs = [baseRun], jobs = [baseJob], current = baseRun, total, workflowRecord = workflow } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith("/workflows/cloud-readiness.yml")) return workflowRecord;
    if (path.includes("/workflows/123/runs?")) return { total_count: total ?? runs.length, workflow_runs: runs };
    if (path.includes("/attempts/")) {
      assert.ok(path.includes(`/attempts/${runs.at(-1).run_attempt}/jobs?`));
      const page = Number(new URL("https://api.github.com" + path).searchParams.get("page"));
      return { jobs: jobs.slice((page - 1) * 100, page * 100) };
    }
    if (path.endsWith("/runs/456")) return current;
    throw new Error(`Unexpected API path: ${path}`);
  };
  return { api, calls };
}

test("source proof passes while image work is still running, or has failed", async () => {
  for (const overrides of [{}, { status: "completed", conclusion: "failure" }]) {
    const run = { ...baseRun, ...overrides };
    const { api, calls } = fixture({ runs: [run], current: run });
    assert.deepEqual(await readSourceVerification(sha, api), { sha, runId: 456, attempt: 2, jobId: 789 });
    assert.ok(calls.some((path) => path.includes(`head_sha=${sha}&event=push&branch=master`)));
    assert.ok(calls.some((path) => path.includes("/attempts/2/jobs?")));
  }
});

test("only the expected workflow, repository, master push, and full SHA can supply proof", async () => {
  for (const overrides of [
    { workflow_id: 999 }, { path: ".github/workflows/pr.yml" },
    { repository: { full_name: "other/paperclip" } }, { head_repository: { full_name: "fork/paperclip" } },
    { head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "workflow_dispatch" },
    { run_attempt: undefined }, { run_attempt: 0 },
  ]) {
    const { api, calls } = fixture({ runs: [{ ...baseRun, ...overrides }] });
    assert.equal(await readSourceVerification(sha, api), undefined, JSON.stringify(overrides));
    assert.equal(calls.length, 2);
  }
});

test("a newer pending run cannot fall back to an older successful run", async () => {
  const newer = { ...baseRun, id: 457, run_attempt: 1 };
  const { api } = fixture({ runs: [baseRun, newer], jobs: [] });
  assert.equal(await readSourceVerification(sha, api), undefined);
});

test("job identities and terminal failures fail closed", async () => {
  for (const overrides of [
    { head_sha: "b".repeat(40) }, { run_id: 999 }, { run_attempt: 1 },
    { conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "skipped" },
  ]) {
    const { api } = fixture({ jobs: [{ ...baseJob, ...overrides }],
      current: overrides.conclusion === "skipped" ? { ...baseRun, status: "completed", conclusion: "success" } : baseRun });
    await assert.rejects(readSourceVerification(sha, api), /did not pass/);
  }
});

test("a rerun racing the jobs read cannot reuse the previous attempt", async () => {
  const { api } = fixture({ current: { ...baseRun, run_attempt: 3 } });
  assert.equal(await readSourceVerification(sha, api), undefined);
});

test("the versioned proof must exist and be unique", async () => {
  for (const jobs of [[], [{ ...baseJob, name: "Cloud deployable v1" }]]) {
    await assert.rejects(readSourceVerification(sha, fixture({ runs: [{ ...baseRun, status: "completed" }], jobs }).api), /did not pass/);
  }
  await assert.rejects(readSourceVerification(sha, fixture({ jobs: [baseJob, baseJob] }).api), /ambiguous/);
});

test("proof may appear after the first page of jobs", async () => {
  const jobs = [...Array.from({ length: 100 }, (_, index) => ({ ...baseJob, name: `test ${index}` })), baseJob];
  const { api, calls } = fixture({ jobs });
  assert.equal((await readSourceVerification(sha, api)).jobId, 789);
  assert.ok(calls.some((path) => path.endsWith("page=2")));
});

test("incomplete discovery and API failures cannot bless a release", async () => {
  for (const total of [2, 101, -1]) {
    await assert.rejects(readSourceVerification(sha, fixture({ total }).api), /incomplete/);
  }
  await assert.rejects(readSourceVerification(sha, fixture({ workflowRecord: { ...workflow, path: ".github/workflows/pr.yml" } }).api), /identity/);
  await assert.rejects(readSourceVerification(sha, async () => { throw new Error("API unavailable"); }), /API unavailable/);
});

test("a missing or pending source proof waits and has a bounded deadline", async () => {
  let time = 0;
  let polls = 0;
  const { api } = fixture({ runs: [] });
  await assert.rejects(waitForSourceVerification(sha, {
    api: async (path) => { if (path.endsWith(".yml")) polls += 1; return api(path); },
    now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 50, intervalMs: 30, log: () => {},
  }), /timed out/);
  assert.equal(time, 50);
  assert.equal(polls, 2);
});

test("pending verification succeeds when its exact job completes", async () => {
  let time = 0;
  const pending = fixture({ jobs: [{ ...baseJob, status: "in_progress", conclusion: null }] });
  const passed = fixture();
  const proof = await waitForSourceVerification(sha, {
    api: (path) => (time ? passed.api : pending.api)(path), now: () => time,
    sleep: async (ms) => { time += ms; }, timeoutMs: 100, intervalMs: 30, log: () => {},
  });
  assert.equal(proof.sha, sha);
  assert.equal(time, 30);
});

test("malformed source refs are rejected before any request", async () => {
  for (const ref of ["master", "a".repeat(7), "A".repeat(40), undefined]) {
    await assert.rejects(readSourceVerification(ref, () => assert.fail("must not request")), /full lowercase/);
  }
});

// A gateway error during the poll must not decide the release. These cover the
// reader's transport only; the verification semantics above are unchanged.
function reader({ responses, attempts = 4, ...options }) {
  const seen = [];
  const waits = [];
  const fetchImpl = async () => {
    const next = responses[seen.length];
    seen.push(next);
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null },
      json: async () => {
        if (next.bodyError) throw next.bodyError;
        return next.body ?? { ok: true };
      },
    };
  };
  const api = createActionsReader({
    token: "t", fetchImpl, attempts, backoffMs: 10,
    sleep: async (ms) => { waits.push(ms); }, log: () => {}, ...options,
  });
  return { api, seen, waits };
}

test("a transient gateway error is retried instead of failing the release", async () => {
  const { api, seen, waits } = reader({ responses: [{ status: 502 }, { status: 200, body: { id: 1 } }] });
  assert.deepEqual(await api("/repos/x"), { id: 1 });
  assert.equal(seen.length, 2);
  assert.deepEqual(waits, [10]);
});

test("every transient status is retried, and the backoff grows", async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const { api, seen, waits } = reader({ responses: [{ status }, { status }, { status: 200, body: { ok: true } }] });
    await api("/repos/x");
    assert.equal(seen.length, 3, `status ${status} should be retried`);
    assert.deepEqual(waits, [10, 20]);
  }
});

test("a rate-limited 403 is retried, and a forbidden 403 is not", async () => {
  // GitHub reports both primary and secondary rate limits as 403; only the
  // headers tell them apart from a token that may not read Actions.
  for (const headers of [{ "retry-after": "1" }, { "x-ratelimit-remaining": "0" }]) {
    const { api, seen } = reader({ responses: [{ status: 403, headers }, { status: 200, body: { ok: true } }] });
    await api("/repos/x");
    assert.equal(seen.length, 2, `403 with ${JSON.stringify(headers)} should be retried`);
  }
  for (const headers of [undefined, { "x-ratelimit-remaining": "4999" }]) {
    const { api, seen } = reader({ responses: [{ status: 403, headers }, { status: 200 }] });
    await assert.rejects(api("/repos/x"), /HTTP 403/);
    assert.equal(seen.length, 1, "a forbidden 403 must fail on the first response");
  }
});

test("Retry-After sets the wait, capped so one header cannot stall the poll", async () => {
  const { api, waits } = reader({ responses: [{ status: 429, headers: { "retry-after": "5" } }, { status: 200 }] });
  await api("/repos/x");
  assert.deepEqual(waits, [5_000]);

  const capped = reader({ responses: [{ status: 429, headers: { "retry-after": "86400" } }, { status: 200 }], maxRetryAfterMs: 60_000 });
  await capped.api("/repos/x");
  assert.deepEqual(capped.waits, [60_000]);
});

test("a body that fails while being read is retried", async () => {
  const { api, seen } = reader({
    responses: [{ status: 200, bodyError: new Error("terminated") }, { status: 200, body: { id: 7 } }],
  });
  assert.deepEqual(await api("/repos/x"), { id: 7 });
  assert.equal(seen.length, 2);
});

test("a network failure is retried, and its message survives exhaustion", async () => {
  const { api, seen } = reader({ responses: Array.from({ length: 4 }, () => new Error("fetch failed")) });
  await assert.rejects(api("/repos/x"), /GitHub Actions read failed: fetch failed/);
  assert.equal(seen.length, 4);
});

test("an authorization failure is not retried", async () => {
  for (const status of [401, 404, 422]) {
    const { api, seen } = reader({ responses: [{ status }, { status: 200 }] });
    await assert.rejects(api("/repos/x"), new RegExp(`HTTP ${status}`));
    assert.equal(seen.length, 1, `status ${status} must fail on the first response`);
  }
});

test("a transient status that never clears fails after its attempt budget", async () => {
  const { api, seen } = reader({ responses: Array.from({ length: 4 }, () => ({ status: 502 })) });
  await assert.rejects(api("/repos/x"), /HTTP 502/);
  assert.equal(seen.length, 4);
});

test("retries stop at the caller's deadline rather than outliving the poll", async () => {
  // The wait this attempt would cost does not fit before the deadline, so the
  // read reports the failure instead of sleeping past the timeout it serves.
  let clock = 0;
  const { api, seen, waits } = reader({
    responses: [{ status: 502 }, { status: 200 }],
    now: () => clock, deadlineAt: () => 5,
  });
  await assert.rejects(api("/repos/x"), /HTTP 502/);
  assert.equal(seen.length, 1);
  assert.deepEqual(waits, []);
});


describe("image build source monitor", () => {
  const sha = "a".repeat(40);
  const runId = 50;
  const attempt = 1;
  const workflow = { id: 123, path: ".github/workflows/cloud-readiness.yml" };
  const sourceRun = { id: 99, workflow_id: 123, path: workflow.path, run_attempt: 1,
    repository: { full_name: "paperclipai/paperclip" }, head_repository: { full_name: "paperclipai/paperclip" },
    head_sha: sha, head_branch: "master", event: "push", status: "in_progress" };
  const imageRun = { id: runId, run_attempt: attempt, head_sha: sha, head_branch: "master", event: "push",
    repository: { id: 1170821064 }, head_repository: { id: 1170821064 },
    path: ".github/workflows/docker.yml", status: "in_progress" };
  const proof = { id: 111, name: "Cloud source verified v1", run_id: 99, run_attempt: 1,
    head_sha: sha, status: "completed", conclusion: "success" };

  function fixture({ jobs = [proof], run = sourceRun, current = run, image = imageRun, imageJobs = [], missing = false } = {}) {
    const cancellations = [];
    const messages = [];
    const api = async path => {
      if (path.endsWith("/workflows/cloud-readiness.yml")) return workflow;
      if (path.includes("/workflows/123/runs?")) return { workflow_runs: missing ? [] : [run], total_count: missing ? 0 : 1 };
      if (path.includes("/runs/99/attempts/1/jobs?")) return { jobs };
      if (path.endsWith("/runs/99")) return current;
      if (path.includes(`/runs/${runId}/attempts/${attempt}/jobs?`)) return { jobs: imageJobs, total_count: imageJobs.length };
      if (path.endsWith(`/runs/${runId}`)) return image;
      throw new Error(`Unexpected request: ${path}`);
    };
    return { sha, runId, attempt, api, cancel: async path => cancellations.push(path),
      cancellations, messages, log: message => messages.push(message), summary: async message => messages.push(message) };
  }

  test("successful exact-source proof permits publication without canceling image work", async () => {
    const f = fixture();
    assert.equal((await watchReleaseSource(f)).jobId, proof.id);
    assert.deepEqual(f.cancellations, []);
  });

  test("a required check failing cancels the same image attempt before siblings finish", async () => {
    const f = fixture({ jobs: [{ ...proof, name: "General tests", conclusion: "failure" }] });
    await assert.rejects(watchReleaseSource(f), /General tests/);
    assert.deepEqual(f.cancellations, ["/repos/paperclipai/paperclip/actions/runs/99/cancel", `/repos/paperclipai/paperclip/actions/runs/${runId}/cancel`]);
  });

  test("a superseded readiness attempt cancels image work with no deployable future", async () => {
    const f = fixture({ jobs: [], run: { ...sourceRun, status: "completed", conclusion: "cancelled" } });
    await assert.rejects(watchReleaseSource(f), /did not pass/);
    assert.equal(f.cancellations.length, 1);
  });

  test("a rerun racing a failed job is retried rather than canceling the image", async () => {
    const f = fixture({ jobs: [{ ...proof, name: "General tests", conclusion: "failure" }],
      current: { ...sourceRun, run_attempt: 2 } });
    let time = 0;
    const api = f.api;
    f.api = async path => time > 0 ? fixture().api(path) : api(path);
    const result = await watchReleaseSource({ ...f, now: () => time, sleep: async ms => { time += ms; } });
    assert.equal(result.jobId, proof.id);
    assert.deepEqual(f.cancellations, []);
  });

  test("a transport failure does not issue a destructive cancellation", async () => {
    const f = fixture();
    await assert.rejects(watchReleaseSource({ ...f, api: async () => { throw new Error("GitHub unavailable"); } }), /unavailable/);
    assert.deepEqual(f.cancellations, []);
  });

  test("the observation window ends without cancelling healthy pending verification", async () => {
    const f = fixture({ missing: true });
    let time = 0;
    const proof = await watchReleaseSource({ ...f, now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 20 });
    assert.equal(proof, undefined);
    assert.equal(time, 20);
    assert.deepEqual(f.cancellations, []);
    assert.ok(f.messages.some(message => message.includes("final publication still requires exact-source verification")));
  });

  test("final publication requires proof even after the early observation window ends", async () => {
    const f = fixture({ missing: true });
    let time = 0;
    await assert.rejects(watchReleaseSource({ ...f, requireProof: true, now: () => time,
      sleep: async ms => { time += ms; }, timeoutMs: 20 }), /before the publication deadline/);
    assert.deepEqual(f.cancellations, []);
    assert.equal((await watchReleaseSource({ ...fixture(), requireProof: true })).jobId, proof.id);
  });

  test("cancellation rejects another SHA, repository, ref, workflow, or attempt", async () => {
    for (const change of [{ head_sha: "b".repeat(40) }, { head_branch: "v1" }, { event: "pull_request" },
      { path: ".github/workflows/release.yml" }, { run_attempt: 2 }, { id: 51 },
      { repository: { id: 42 } }, { head_repository: { id: 42 } }]) {
      const f = fixture({ image: { ...imageRun, ...change } });
      await assert.rejects(cancelImageRun(f), /different image workflow identity/);
      assert.deepEqual(f.cancellations, []);
    }
  });

  test("queue measurement does not count running time or skipped dependency jobs", () => {
    const created_at = "2020-01-01T00:00:00Z";
    const started_at = "2020-01-01T00:00:20Z";
    const job = { id: 1, name: "amd64", labels: ["release"], created_at, started_at, runner_id: 10, status: "in_progress" };
    const now = Date.parse(created_at) + 120_000;
    assert.deepEqual(runnerWaits([job, { ...job, status: "completed", conclusion: "skipped" }], now), [{ id: 1, job: "amd64", seconds: 20 }]);
    assert.equal(runnerWaits([{ ...job, status: "queued", runner_id: 0 }], now)[0].seconds, 120);
  });

  test("a runner wait over 60 seconds produces an Actions warning and summary", async () => {
    const f = fixture({ imageJobs: [{ id: 1, name: "amd64", labels: ["release"], status: "queued", runner_id: 0, created_at: "2020-01-01T00:00:00Z" }] });
    await watchReleaseSource({ ...f, now: () => Date.parse("2020-01-01T00:02:00Z") });
    assert.ok(f.messages.some(message => message.startsWith("::warning") && message.includes("120s")));
    assert.ok(f.messages.some(message => message.includes("Release runner wait: amd64")));
  });
});

describe("release candidate admission", () => {
  const repository = { id: 1170821064, full_name: "paperclipai/paperclip" };
  const ids = { "docker.yml": 101, "release.yml": 102, "cloud-readiness.yml": 123, "cloud-migrator-artifacts.yml": 124 };
  function run(file, change = {}) {
    return { id: ids[file] + 1000, workflow_id: ids[file], path: `.github/workflows/${file}`,
      repository, head_repository: repository, head_sha: sha, head_branch: "master", event: "push",
      run_attempt: 1, status: "in_progress", conclusion: null, ...change };
  }
  function job(run, name, conclusion = "skipped") {
    return { id: 789, run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
      name, status: "completed", conclusion };
  }
  function fixture(file = "cloud-readiness.yml", change = {}) {
    const producer = run(file, { status: "completed", conclusion: "success", ...change });
    const admission = file === "cloud-migrator-artifacts.yml" ? migratorAdmissionJob : sourceAdmissionJob;
    const f = { runs: { [file]: [producer] }, jobs: { [producer.id]: [job(producer, admission, "success"), job(producer, sourceVerificationJob)] },
      current: {}, writes: [], calls: [], requested: new Set(), file, sha, admissionJob: admission };
    f.api = async path => {
      f.calls.push(path);
      const url = new URL(`https://api.github.com${path}`);
      const fileMatch = path.match(/\/workflows\/([^/?]+\.yml)$/);
      if (fileMatch) return { id: ids[fileMatch[1]], path: `.github/workflows/${fileMatch[1]}` };
      const listMatch = path.match(/\/workflows\/(\d+)\/runs\?/);
      if (listMatch) {
        const name = Object.keys(ids).find(file => ids[file] === Number(listMatch[1]));
        const runs = f.runs[name] ?? [];
        return { workflow_runs: runs, total_count: f.total ?? runs.length };
      }
      const jobMatch = path.match(/\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/);
      if (jobMatch) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const jobs = f.jobs[Number(jobMatch[1])] ?? [];
        return { total_count: f.jobTotal ?? jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) };
      }
      const currentMatch = path.match(/\/runs\/(\d+)$/);
      if (currentMatch) return f.current[Number(currentMatch[1])] ?? Object.values(f.runs).flat().find(run => run.id === Number(currentMatch[1]));
      throw new Error(`Unexpected admission API path: ${path}`);
    };
    f.rerun = async path => f.writes.push(path);
    return f;
  }

  test("only a running image or npm release admits a normal push", async () => {
    for (const file of ["docker.yml", "release.yml"]) {
      const f = fixture();
      assert.equal(await releaseAdmitted(sha, f), false);
      f.runs[file] = [run(file)];
      assert.equal(await releaseAdmitted(sha, f), true);
      assert.equal(await releaseAdmitted(sha, { ...f, imageOnly: true }), file === "docker.yml");
      for (const status of ["queued", "pending", "completed"]) {
        f.runs[file] = [run(file, { status })];
        assert.equal(await releaseAdmitted(sha, f), false, status);
      }
    }
  });

  test("manual and retry requests admit exact source without consumer discovery", async () => {
    const api = () => assert.fail("explicit request needs no discovery");
    assert.equal(await releaseAdmitted(sha, { api, event: "workflow_dispatch" }), true);
    assert.equal(await releaseAdmitted(sha, { api, attempt: 2 }), true);
    assert.equal(await releaseAdmitted(sha, { api, event: "pull_request", attempt: 2 }), false);
    for (const attempt of [0, "2"]) {
      await assert.rejects(releaseAdmitted(sha, { api, attempt }), /Invalid release attempt/);
    }
  });

  test("forks, stale identities, tags, and non-push consumers do not admit work", async () => {
    for (const change of [{ repository: { ...repository, id: 2 } }, { head_repository: { ...repository, id: 2 } },
      { repository: { ...repository, full_name: "fork/paperclip" } }, { path: ".github/workflows/pr.yml" },
      { workflow_id: 999 }, { head_sha: "b".repeat(40) }, { head_branch: "v1" }, { event: "workflow_dispatch" },
      { id: 0 }, { run_attempt: 0 }]) {
      const f = fixture();
      f.runs["docker.yml"] = [run("docker.yml", change)];
      assert.equal(await releaseAdmitted(sha, f), false, JSON.stringify(change));
    }
    const f = fixture();
    const active = run("docker.yml");
    f.runs["docker.yml"] = [active];
    f.current[active.id] = { ...active, run_attempt: 2 };
    assert.equal(await releaseAdmitted(sha, f), false);
  });

  test("incomplete discovery and transport failure fail closed", async () => {
    for (const total of [1, 101, -1]) {
      const f = fixture();
      f.total = total;
      await assert.rejects(releaseAdmitted(sha, f), /Incomplete/);
      assert.deepEqual(f.writes, []);
    }
    await assert.rejects(releaseAdmitted(sha, { api: async () => { throw new Error("API unavailable"); } }), /unavailable/);
    await assert.rejects(releaseAdmitted("master", { api: () => assert.fail() }), /full source SHA/);
  });

  test("a selected consumer restarts only a strictly deferred producer, once", async () => {
    for (const file of ["cloud-readiness.yml", "cloud-migrator-artifacts.yml"]) {
      const f = fixture(file);
      assert.equal(await requestDeferredProducer(f), "pending");
      assert.deepEqual(f.writes, [`/repos/paperclipai/paperclip/actions/runs/${ids[file] + 1000}/rerun`]);
      await requestDeferredProducer(f);
      assert.equal(f.writes.length, 1);
    }
  });

  test("failed, incomplete, ambiguous, or mismatched work is never automatically retried", async () => {
    for (const change of [jobs => { jobs[1].conclusion = "failure"; }, jobs => { jobs[0].conclusion = "failure"; },
      jobs => { jobs[1].run_attempt = 2; }, jobs => { jobs[1].head_sha = "b".repeat(40); },
      jobs => { jobs[1].run_id = 2; }, jobs => { jobs[1].status = "queued"; },
      jobs => { jobs.push({ ...jobs[0] }); }, jobs => { jobs.splice(1); }]) {
      const f = fixture();
      change(f.jobs[1123]);
      assert.equal(await requestDeferredProducer(f), "finished");
      assert.deepEqual(f.writes, []);
    }
    const f = fixture();
    for (const change of [{ run_attempt: 2 }, { status: "in_progress" }, { head_sha: "b".repeat(40) }, { id: 2 }]) {
      f.current[1123] = { ...f.runs[f.file][0], ...change };
      assert.equal(await requestDeferredProducer(f), "pending");
      assert.deepEqual(f.writes, []);
    }
  });

  test("an explicitly cancelled or failed producer cannot be restarted by admission", async () => {
    for (const conclusion of ["cancelled", "failure", "timed_out"]) {
      const f = fixture("cloud-readiness.yml", { conclusion });
      assert.equal(await requestDeferredProducer(f), "finished");
      assert.deepEqual(f.writes, []);
    }
  });

  test("a truncated job page cannot hide a failed check and trigger a retry", async () => {
    const f = fixture();
    f.jobTotal = 3;
    await assert.rejects(requestDeferredProducer(f), /Incomplete release producer job list/);
    assert.deepEqual(f.writes, []);
    f.jobTotal = "2";
    await assert.rejects(requestDeferredProducer(f), /Invalid release producer job list/);
    assert.deepEqual(f.writes, []);
  });

  test("producer retries reject arbitrary workflow and admission contracts", async () => {
    const f = fixture();
    for (const change of [{ file: "docker.yml" }, { admissionJob: migratorAdmissionJob }]) {
      await assert.rejects(requestDeferredProducer({ ...f, ...change }), /Unknown deferred/);
    }
    assert.deepEqual(f.calls, []);
  });

  test("a deferred completion racing the run listing does not become a source failure", async () => {
    const f = fixture();
    const completed = f.runs[f.file][0];
    f.runs[f.file] = [{ ...completed, status: "in_progress", conclusion: null }];
    f.current[completed.id] = completed;
    await assert.rejects(readSourceVerification(sha, f.api), SourceVerificationDeferred);
    delete f.current[completed.id];
    assert.equal(await readSourceVerification(sha, f.api), undefined);
  });

  test("a competing consumer's accepted retry does not fail the losing consumer", async () => {
    const f = fixture();
    f.rerun = async () => {
      f.current[1123] = run(f.file, { run_attempt: 2 });
      throw new Error("duplicate restart rejected");
    };
    assert.equal(await requestDeferredProducer(f), "pending");
    assert.equal(f.requested.size, 1);
    const rejected = fixture();
    rejected.rerun = async () => { throw new Error("token denied"); };
    await assert.rejects(requestDeferredProducer(rejected), /token denied/);
    assert.equal(rejected.requested.size, 0);
  });

  test("a queued migrator is pending until its build actually starts", async () => {
    const f = fixture("cloud-migrator-artifacts.yml", { status: "in_progress", conclusion: null });
    const producer = f.runs[f.file][0];
    const build = { ...job(producer, "Build migrator", null), status: "queued", labels: ["cloud-release-32"] };
    f.jobs[producer.id] = [job(producer, migratorAdmissionJob, "success"), build];
    assert.equal(await requestDeferredProducer(f), "pending");
    build.status = "in_progress";
    assert.equal(await requestDeferredProducer(f), "pending", "labels alone do not prove a worker started");
    build.runner_id = 123;
    assert.equal(await requestDeferredProducer(f), "admitted");
    build.run_attempt = 2;
    assert.equal(await requestDeferredProducer(f), "pending", "a stale build cannot admit work");
    assert.deepEqual(f.writes, []);
  });

  test("a rejected duplicate with stale read visibility remains pending without claiming admission", async () => {
    for (const status of [409, 422, 403]) {
      const f = fixture();
      f.rerun = async () => { throw Object.assign(new Error("retry rejected"), { status }); };
      if (status === 403) await assert.rejects(requestDeferredProducer(f), /retry rejected/);
      else assert.equal(await requestDeferredProducer(f), "pending");
      assert.equal(f.requested.size, 0);
    }
  });

  test("source proof waits for admission, restarts it, and accepts only the new attempt", async () => {
    const f = fixture();
    await assert.rejects(readSourceVerification(sha, f.api), SourceVerificationDeferred);
    let time = 0;
    const proof = await waitForSourceVerification(sha, { ...f, now: () => time, intervalMs: 10, timeoutMs: 30, log: () => {},
      sleep: async ms => {
        time += ms;
        const selected = run(f.file, { run_attempt: 2 });
        f.runs[f.file] = [selected];
        f.jobs[selected.id] = [job(selected, sourceAdmissionJob, "success"), job(selected, sourceVerificationJob, "success")];
      } });
    assert.equal(proof.attempt, 2);
    assert.equal(time, 10);
    assert.equal(f.writes.length, 1);
  });

  test("the image monitor waits for actual migrator publication after deferred admission", async () => {
    const f = fixture("cloud-migrator-artifacts.yml");
    const source = run("cloud-readiness.yml");
    f.runs["cloud-readiness.yml"] = [source];
    f.jobs[source.id] = [job(source, sourceVerificationJob, "success")];
    const image = run("docker.yml");
    f.runs["docker.yml"] = [image];
    f.jobs[image.id] = [];
    let time = 0;
    const proof = await watchReleaseSource({ ...f, runId: image.id, attempt: 1, cancel: () => assert.fail("must not cancel"),
      now: () => time, intervalMs: 10, timeoutMs: 30, log: () => {}, summary: async () => {}, sleep: async ms => {
        time += ms;
        const selected = run(f.file, { run_attempt: 2, ...(time >= 20 ? { status: "completed", conclusion: "success" } : {}) });
        f.runs[f.file] = [selected];
        f.jobs[selected.id] = [time >= 20 ? job(selected, "publish", "success") :
          { ...job(selected, "Build migrator", null), status: "in_progress", labels: ["cloud-release-32"], runner_id: 123 }];
      } });
    assert.equal(proof.sha, sha);
    assert.equal(time, 20);
    assert.equal(f.writes.length, 1);
  });

  test("migrator publication rejects skipped, stale, failed and duplicate publisher evidence", async () => {
    const f = fixture("cloud-migrator-artifacts.yml");
    const selected = f.runs[f.file][0];
    assert.equal(await readMigratorPublication(sha, f.api), false);
    f.jobs[selected.id] = [job(selected, "publish", "success")];
    assert.equal(await readMigratorPublication(sha, f.api), true);
    for (const change of [{ conclusion: "skipped" }, { run_attempt: 2 }, { run_id: 1 }, { head_sha: "b".repeat(40) }, { status: "queued" }]) {
      f.jobs[selected.id] = [{ ...job(selected, "publish", "success"), ...change }];
      assert.equal(await readMigratorPublication(sha, f.api), false);
    }
    f.jobs[selected.id] = [job(selected, "publish", "success"), job(selected, "publish", "success")];
    assert.equal(await readMigratorPublication(sha, f.api), false);
    f.current[selected.id] = { ...selected, conclusion: "failure" };
    await assert.rejects(readMigratorPublication(sha, f.api), /migrator publication failed/);
    assert.deepEqual(f.writes, [], "a read never retries a failed producer");
  });

  test("a publication retry racing job evidence invalidates the old success", async () => {
    const f = fixture("cloud-migrator-artifacts.yml");
    const selected = f.runs[f.file][0];
    f.jobs[selected.id] = [job(selected, "publish", "success")];
    let reads = 0;
    const api = async path => {
      if (path.endsWith(`/runs/${selected.id}`) && ++reads === 2) return { ...selected, run_attempt: 2 };
      return f.api(path);
    };
    assert.equal(await readMigratorPublication(sha, api), false);
  });

  test("the retry transport is a bounded POST to a canonical run", async () => {
    const calls = [];
    const rerun = createReleaseRerunner("fixture", async (url, options) => { calls.push({ url, options }); return { ok: true }; });
    await assert.rejects(rerun("/repos/fork/paperclip/actions/runs/1/rerun"), /Invalid release retry/);
    await rerun("/repos/paperclipai/paperclip/actions/runs/1/rerun");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.redirect, "error");
  });
});
