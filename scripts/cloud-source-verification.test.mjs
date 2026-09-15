import assert from "node:assert/strict";
import test from "node:test";
import { createActionsReader, readSourceVerification, sourceVerificationJob, waitForSourceVerification } from "./cloud-source-verification.mjs";

const sha = "a".repeat(40);
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
    const { api } = fixture({ jobs: [{ ...baseJob, ...overrides }] });
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
