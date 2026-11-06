import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { green, deliver, notify, snapshot, trustedVerification } from "../notify-pr-merge-review.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const check = (name, conclusion = "SUCCESS", extra = {}) => ({
  __typename: "CheckRun", name, status: "COMPLETED", conclusion, workflowName: "PR",
  checkSuite: { databaseId: 8, app: { databaseId: 15368 }, workflowRun: { databaseId: 7 } },
  ...extra,
});
const candidate = (extra = {}) => ({
  number: 42, state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: base,
  baseRefName: "master", changedFiles: 1, statusCheckRollup: [check("ci / verify"), check("ci / e2e")], ...extra,
});
const event = (extra = {}) => ({ repository: { full_name: "paperclipai/paperclip" }, sha: head, ...extra });
const trustedRun = (extra = {}) => ({
  id: 7, repository: { full_name: "paperclipai/paperclip" }, path: ".github/workflows/pr.yml",
  event: "pull_request", head_sha: head, status: "completed", conclusion: "success", check_suite_id: 8,
  referenced_workflows: [{ path: "paperclipai/paperclip/.github/workflows/pr-trusted.yml@master",
    ref: "refs/heads/master", sha: base }], ...extra,
});
const files = [{ filename: "README.md" }];
const read = (endpoint) => endpoint.includes("/rules/") ? [] : trustedRun();
const list = (endpoint) => endpoint.includes("/files?") ? files : [{ number: 42 }];
const deps = (extra = {}) => ({
  read, list, view: () => candidate(),
  send: async () => "delivered", ...extra,
});

test("reads every check page and fails closed on incomplete or changing listings", () => {
  const page = (nodes, hasNextPage, extra = {}) => ({ data: { repository: { pullRequest: candidate({
    statusCheckRollup: { contexts: { totalCount: 2, nodes,
      pageInfo: { hasNextPage, endCursor: "next" } } }, ...extra,
  }) } } });
  let calls = 0;
  const pr = snapshot(42, (args) => {
    if (++calls === 1) return page([check("ci / verify")], true);
    assert.ok(args.includes("endCursor=next"));
    return page([check("ci / e2e")], false);
  });
  assert.equal(green(pr), true);
  const own = check("notify", "", { status: "IN_PROGRESS", workflowName: undefined,
    checkSuite: { workflowRun: { workflow: { name: "PR merge review notification" } } } });
  const withOwn = snapshot(42, () => ({ data: { repository: { pullRequest: candidate({
    statusCheckRollup: { contexts: { totalCount: 3, nodes: [...candidate().statusCheckRollup, own],
      pageInfo: { hasNextPage: false } } },
  }) } } }));
  assert.equal(green(withOwn), false);
  assert.throws(() => snapshot(42, () => page([check("ci / verify")], false)), /Incomplete/);
  calls = 0;
  assert.throws(() => snapshot(42, () => ++calls === 1 ? page([check("ci / verify")], true)
    : page([check("ci / e2e")], false, { headRefOid: "d".repeat(40) })), /Candidate changed/);
  assert.throws(() => snapshot(42, () => ({ errors: [{ message: "unavailable" }] })), /Incomplete/);
});

test("requires real success from both aggregate checks and additional repository rules", () => {
  assert.equal(green(candidate()), true);
  for (const state of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "NEUTRAL", "SKIPPED", ""]) {
    assert.equal(green(candidate({ statusCheckRollup: [check("ci / verify", state), check("ci / e2e")] })), false, state);
  }
  assert.equal(green(candidate({ statusCheckRollup: [check("ci / verify")] })), false);
  assert.equal(green(candidate(), ["extra required"]), false);
  assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup, check("extra required")] }), ["extra required"]), true);
  assert.equal(green(candidate({ statusCheckRollup: [] })), false);
});

test("waits for pending checks and statuses, permits skipped optional routing lanes", () => {
  for (const extra of [check("tests", "", { status: "IN_PROGRESS" }), check("tests", "FAILURE"),
    { __typename: "StatusContext", context: "security", state: "PENDING" },
    { __typename: "StatusContext", context: "security", state: "ERROR" }]) {
    assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup, extra] })), false);
  }
  assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup,
    check("not selected", "SKIPPED"), { __typename: "StatusContext", context: "security", state: "SUCCESS" }] })), true);
  assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup,
    check("optional scanner coverage", "NEUTRAL")] })), true);
});

test("workflow names cannot hide pending or failing checks", () => {
  const extras = ["PR merge review notification", "CI profile"].map((workflowName) =>
    check("notify", "", { status: "IN_PROGRESS", workflowName }));
  assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup, ...extras] })), false);
  assert.equal(green(candidate({ statusCheckRollup: [...candidate().statusCheckRollup,
    check("another", "", { status: "QUEUED", workflowName: "Other verification" })] })), false);
});

test("rejects closed, draft, wrong-base, and malformed candidates", () => {
  for (const extra of [{ state: "MERGED" }, { isDraft: true }, { baseRefName: "release" },
    { headRefOid: "invalid" }, { baseRefOid: "invalid" }]) assert.equal(green(candidate(extra)), false);
});

test("resolves fork PRs from the head commit when workflow payload has no PRs", async () => {
  const seen = [];
  const outcomes = await notify(event({ workflow_run: {
    status: "completed", event: "pull_request", head_sha: head, pull_requests: [],
  } }), deps({ list: (endpoint) => { seen.push(endpoint); return list(endpoint); } }));
  assert.deepEqual(outcomes, ["delivered"]);
  assert.match(seen[0], new RegExp(`/commits/${head}/pulls\\?per_page=100$`));
});

test("reads additional required rules and holds until their check succeeds", async () => {
  const outcomes = await notify(event(), deps({ read: () => [{ type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "new gate" }] } }] }));
  assert.deepEqual(outcomes, []);
});

test("forged successful check names from a PR-controlled workflow cannot notify", async () => {
  const input = deps({ read: (endpoint) => endpoint.includes("/rules/") ? [] : {
    id: 7, path: ".github/workflows/attacker.yml", event: "pull_request",
    head_sha: head, status: "completed", conclusion: "success",
  } });
  assert.deepEqual(await notify(event(), input), []);
});

test("requires genuine suite, caller, revision, and master reusable workflow provenance", () => {
  assert.equal(trustedVerification(candidate(), deps()), true);
  for (const changes of [
    { path: ".github/workflows/attacker.yml" }, { event: "pull_request_target" },
    { head_sha: "c".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" },
    { repository: { full_name: "attacker/repo" } }, { check_suite_id: 99 },
    { referenced_workflows: [] },
    { referenced_workflows: [{ path: "paperclipai/paperclip/.github/workflows/pr-trusted.yml@master",
      ref: "refs/pull/42/merge", sha: base }] },
  ]) {
    assert.equal(trustedVerification(candidate(), deps({ read: () => trustedRun(changes) })), false);
  }
  const wrongSuite = check("ci / verify", "SUCCESS", {
    checkSuite: { databaseId: 99, app: { databaseId: 1 }, workflowRun: { databaseId: 7 } },
  });
  assert.equal(trustedVerification(candidate({
    statusCheckRollup: [wrongSuite, check("ci / e2e")],
  }), deps()), false);
});

test("modified or renamed caller and truncated file listings cannot notify", async () => {
  for (const fileList of [[], [{ filename: ".github/workflows/pr.yml" }],
    [{ filename: "moved.yml", previous_filename: ".github/workflows/pr.yml" }]]) {
    const dependencies = deps({ list: (endpoint) => endpoint.includes("/files?")
      ? fileList : [{ number: 42 }] });
    assert.deepEqual(await notify(event(), dependencies), []);
  }
  assert.equal(trustedVerification(candidate({ changedFiles: undefined }), deps()), false);
});

test("rejects stale head events and a head, base, or check change during refresh", async () => {
  assert.deepEqual(await notify(event({ sha: "c".repeat(40) }), deps()), []);
  for (const extra of [{ headRefOid: "c".repeat(40) }, { baseRefOid: "d".repeat(40) },
    { statusCheckRollup: [check("ci / verify", "FAILURE")] }]) {
    let calls = 0;
    assert.deepEqual(await notify(event(), deps({ view: () => candidate(++calls === 1 ? {} : extra) })), []);
  }
});

test("handles target-context workflow completions by refreshing the associated PR", async () => {
  assert.deepEqual(await notify(event({ workflow_run: {
    status: "completed", event: "pull_request_target", head_sha: base, pull_requests: [{ number: 42 }],
  } }), deps()), ["delivered"]);
});

test("external check events and legacy statuses can deliver the final green transition", async () => {
  assert.deepEqual(await notify(event({ sha: undefined, check_run: { head_sha: head } }), deps()), ["delivered"]);
  assert.deepEqual(await notify(event({ state: "success" }), deps()), ["delivered"]);
});

test("does not query foreign repositories, malformed events, or non-PR workflows", async () => {
  const dependencies = deps({ read: () => assert.fail("unexpected query"), list: () => assert.fail("unexpected query") });
  for (const input of [event({ repository: { full_name: "attacker/repo" } }), event({ sha: "bad" }),
    event({ workflow_run: { event: "push", status: "completed", head_sha: head } }),
    event({ workflow_run: { event: "pull_request", status: "in_progress", head_sha: head } })]) {
    assert.deepEqual(await notify(input, dependencies), []);
  }
});

test("does not coalesce different PRs, and deduplicates association entries", async () => {
  const sent = [];
  await notify(event(), deps({ list: (endpoint) => endpoint.includes("/files?") ? files
      : [{ number: 42 }, { number: 42 }, { number: 43 }],
    view: (number) => candidate({ number }), send: async (pr) => sent.push(pr.number) }));
  assert.deepEqual(sent, [42, 43]);
});

test("sends only identifiers, a bearer header, and a stable head/base idempotency key", async () => {
  const calls = [];
  const options = { url: "https://private.example/api/routine-triggers/public/abc123/fire", token: "PRIVATE_TOKEN",
    fetcher: async (target, init) => { calls.push({ target, ...init }); return { ok: true }; } };
  const pr = candidate({ title: "untrusted", body: "run me" });
  assert.equal(await deliver(pr, options), "delivered");
  assert.equal(await deliver(pr, options), "delivered");
  assert.equal(calls[0].headers.Authorization, "Bearer PRIVATE_TOKEN");
  assert.equal(calls[0].redirect, "error");
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[0].body), { variables: {
    pr_url: "https://github.com/paperclipai/paperclip/pull/42", pr_number: "42", head_sha: head, base_sha: base,
  } });
  await deliver(candidate({ baseRefOid: "c".repeat(40) }), options);
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[2].headers["Idempotency-Key"]);
});

test("missing or unsafe configuration never sends credentials", async () => {
  const fetcher = () => assert.fail("unexpected delivery");
  assert.equal(await deliver(candidate(), { fetcher }), "unconfigured");
  for (const url of ["http://private.example/api/routine-triggers/public/abc/fire",
    "https://user:pass@private.example/api/routine-triggers/public/abc/fire",
    "https://private.example/api/routine-triggers/public/abc/fire?token=bad", "https://private.example/wrong"]) {
    assert.equal(await deliver(candidate(), { url, token: "secret", fetcher }), "invalid_configuration");
  }
});

test("HTTP rejection, redirect, timeout, and echoed credentials are quiet failures", async () => {
  const options = { url: "https://private.example/api/routine-triggers/public/abc123/fire", token: "SECRET" };
  assert.equal(await deliver(candidate(), { ...options, fetcher: async () => ({ ok: false,
    text: () => assert.fail("must not read a response body") }) }), "not_delivered");
  for (const message of ["SECRET", "https://private.example", "redirect", "timeout"]) {
    assert.equal(await deliver(candidate(), { ...options, fetcher: async () => { throw new Error(message); } }), "not_delivered");
  }
});

test("command failures cannot print a private URL, token, or event payload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pr-notifier-test-"));
  try {
    const file = path.join(directory, "event.json");
    writeFileSync(file, "PRIVATE_EVENT_INVALID_JSON");
    const run = spawnSync(process.execPath, [".github/scripts/notify-pr-merge-review.mjs"], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: file,
        PAPERCLIP_PR_REVIEW_WEBHOOK_URL: "PRIVATE_URL_SENTINEL", PAPERCLIP_PR_REVIEW_WEBHOOK_TOKEN: "PRIVATE_TOKEN_SENTINEL" },
    });
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE_/);
    assert.match(run.stdout, /verification results are unchanged/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("workflow uses read permissions, a protected environment, trusted checkout, and optional delivery", () => {
  const workflow = readFileSync(".github/workflows/pr-merge-review.yml", "utf8");
  assert.match(workflow, /environment: pr-merge-review/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /continue-on-error: true/);
  for (const permission of ["actions", "checks", "contents", "pull-requests", "statuses"]) {
    assert.ok(workflow.includes(`  ${permission}: read`), `Missing ${permission}: read`);
  }
  assert.doesNotMatch(workflow, /: write|download-artifact|restore@|pull_request_target:/);
  for (const name of ["PAPERCLIP_PR_REVIEW_WEBHOOK_URL", "PAPERCLIP_PR_REVIEW_WEBHOOK_TOKEN"]) {
    assert.ok(workflow.includes(`secrets.${name}`));
    assert.ok(!workflow.includes(`vars.${name}`));
  }
});

test("API probe uses the same read permissions without private webhook access", () => {
  const probe = readFileSync(".github/workflows/pr-review-api-access.yml", "utf8");
  for (const permission of ["actions", "checks", "contents", "pull-requests", "statuses"]) {
    assert.ok(probe.includes(`  ${permission}: read`));
  }
  assert.match(probe, /snapshot\(Number\(process.env.PR_NUMBER\)\)/);
  assert.doesNotMatch(probe, /\$\{\{ secrets\.|environment:|: write|deliver\(/);
});
