import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DENIED_FLAGS,
  EXIT_DENIED,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  buildAutoMergeArgs,
  buildRestMergeArgs,
  classifyTransportFailure,
  evaluateReadiness,
  normalizePullRequest,
  parseArgs,
  runMerge,
  summarizeReviews,
} from "../lane.mjs";

const LANE_SOURCE_PATH = new URL("../lane.mjs", import.meta.url);

const HEAD = "1111111111111111111111111111111111111111";
const NEXT_HEAD = "2222222222222222222222222222222222222222";

function greenCheck(name = "PR / build") {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" };
}

function pendingCheck(name = "PR / e2e") {
  return { __typename: "CheckRun", name, status: "IN_PROGRESS", conclusion: null };
}

function failedCheck(name = "PR / test") {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE" };
}

function approval({ login = "reviewer", commitOid = HEAD, submittedAt = "2026-08-25T10:00:00Z" } = {}) {
  return { state: "APPROVED", submittedAt, author: { login }, commit: { oid: commitOid } };
}

function pullRequestPayload({
  state = "OPEN",
  isDraft = false,
  mergeable = "MERGEABLE",
  headRefOid = HEAD,
  author = "implementer",
  reviews = [approval()],
  checks = [greenCheck()],
} = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_node_id",
          number: 12158,
          title: "Restore a repository-standard guarded PR merge command",
          state,
          isDraft,
          mergeable,
          mergeStateStatus: "CLEAN",
          baseRefName: "master",
          headRefOid,
          author: { login: author },
          reviews: { nodes: reviews },
          commits: {
            nodes: [
              {
                commit: {
                  oid: headRefOid,
                  statusCheckRollup: checks.length > 0 ? { state: "SUCCESS", contexts: { nodes: checks } } : null,
                },
              },
            ],
          },
        },
      },
    },
  };
}

function normalized(overrides) {
  return normalizePullRequest(pullRequestPayload(overrides));
}

/**
 * Scripted `gh` stub. Each entry matches on the first two argv tokens so a test
 * can vary what the first and second (re-validation) reads return.
 */
function ghStub(responses) {
  const calls = [];
  const queue = responses.map((response) => ({ ...response }));

  const gh = (args) => {
    calls.push(args);
    if (args[0] === "repo") {
      return { status: 0, stdout: "paperclipai/paperclip\n", stderr: "" };
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    if (next.payload !== undefined) {
      return { status: 0, stdout: JSON.stringify(next.payload), stderr: "" };
    }
    return { status: next.status ?? 0, stdout: next.stdout ?? "{}", stderr: next.stderr ?? "" };
  };

  gh.calls = calls;
  gh.transportCalls = () => calls.filter((args) => args[0] === "api" && !isReadQuery(args));
  return gh;
}

function isReadQuery(args) {
  return args.includes("graphql") && args.some((arg) => typeof arg === "string" && arg.startsWith("query=query("));
}

function silentRun(argv, gh) {
  const logs = [];
  const errors = [];
  const code = runMerge({ argv, gh, log: (line) => logs.push(line), error: (line) => errors.push(line) });
  return { code, out: logs.join("\n"), err: errors.join("\n") };
}

test("parseArgs accepts the documented merge invocation", () => {
  assert.deepEqual(parseArgs(["merge", "12158"]), {
    command: "merge",
    prNumber: 12158,
    auto: false,
    repo: null,
    dryRun: false,
    json: false,
  });
  assert.equal(parseArgs(["merge", "#12158", "--auto"]).auto, true);
  assert.equal(parseArgs(["merge", "12158", "--repo", "paperclipai/paperclip"]).repo, "paperclipai/paperclip");
  assert.equal(parseArgs(["merge", "12158", "--repo=paperclipai/paperclip"]).repo, "paperclipai/paperclip");
});

test("parseArgs rejects every bypass flag by name", () => {
  for (const flag of DENIED_FLAGS.keys()) {
    assert.throws(() => parseArgs(["merge", "12158", flag]), UsageError, `expected ${flag} to be rejected`);
  }
});

test("parseArgs rejects unknown flags, missing numbers, and extra arguments", () => {
  assert.throws(() => parseArgs(["merge", "12158", "--yolo"]), UsageError);
  assert.throws(() => parseArgs(["merge"]), UsageError);
  assert.throws(() => parseArgs(["merge", "not-a-number"]), UsageError);
  assert.throws(() => parseArgs(["merge", "12158", "12159"]), UsageError);
  assert.throws(() => parseArgs(["land", "12158"]), UsageError);
});

test("check verdicts treat unreported and in-flight runs as not green", () => {
  const pullRequest = normalized({
    checks: [
      greenCheck("PR / build"),
      pendingCheck("PR / e2e"),
      failedCheck("PR / test"),
      { __typename: "StatusContext", context: "legacy/status", state: "SUCCESS" },
      { __typename: "StatusContext", context: "legacy/pending", state: "PENDING" },
      { __typename: "CheckRun", name: "PR / skipped", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  });

  const byName = Object.fromEntries(pullRequest.checks.map((check) => [check.name, check.verdict]));
  assert.deepEqual(byName, {
    "PR / build": "green",
    "PR / e2e": "pending",
    "PR / test": "failed",
    "legacy/status": "green",
    "legacy/pending": "pending",
    "PR / skipped": "green",
  });
});

test("summarizeReviews keeps the latest opinionated verdict per reviewer", () => {
  const reviews = [
    approval({ login: "qa", submittedAt: "2026-08-25T09:00:00Z" }),
    { state: "COMMENTED", submittedAt: "2026-08-25T09:30:00Z", author: { login: "qa" }, commit: { oid: HEAD } },
    { state: "APPROVED", submittedAt: "2026-08-25T09:00:00Z", author: { login: "implementer" }, commit: { oid: HEAD } },
    { state: "APPROVED", submittedAt: "2026-08-25T09:00:00Z", author: { login: "drive-by" }, commit: { oid: HEAD } },
    { state: "DISMISSED", submittedAt: "2026-08-25T09:45:00Z", author: { login: "drive-by" }, commit: { oid: HEAD } },
  ];

  const summary = summarizeReviews(
    reviews.map((review) => ({
      state: review.state,
      submittedAt: review.submittedAt,
      login: review.author.login,
      commitOid: review.commit.oid,
    })),
    { authorLogin: "implementer", headOid: HEAD },
  );

  assert.deepEqual(
    summary.approvals.map((review) => review.login),
    ["qa"],
    "a later COMMENTED review must not erase an approval, a DISMISSED review must, and the author's own approval never counts",
  );
});

test("evaluateReadiness passes a green, independently approved pull request", () => {
  const readiness = evaluateReadiness(normalized());
  assert.deepEqual(readiness.denials, []);
  assert.equal(readiness.pinnedHead, HEAD);
});

test("evaluateReadiness denies without an independent approval on the pinned head", () => {
  const selfApproved = evaluateReadiness(normalized({ reviews: [approval({ login: "implementer" })] }));
  assert.deepEqual(selfApproved.denials.map((denial) => denial.code), ["missing_independent_approval"]);

  const stale = evaluateReadiness(normalized({ reviews: [approval({ commitOid: NEXT_HEAD })] }));
  assert.deepEqual(stale.denials.map((denial) => denial.code), ["stale_approval"]);

  const rejected = evaluateReadiness(
    normalized({
      reviews: [
        approval(),
        { state: "CHANGES_REQUESTED", submittedAt: "2026-08-25T11:00:00Z", author: { login: "reviewer" }, commit: { oid: HEAD } },
      ],
    }),
  );
  assert.deepEqual(rejected.denials.map((denial) => denial.code), ["changes_requested", "missing_independent_approval"]);
});

test("evaluateReadiness denies drafts, conflicts, and non-open pull requests", () => {
  assert.ok(evaluateReadiness(normalized({ isDraft: true })).denials.some((d) => d.code === "draft_pull_request"));
  assert.ok(evaluateReadiness(normalized({ mergeable: "CONFLICTING" })).denials.some((d) => d.code === "merge_conflict"));
  assert.ok(evaluateReadiness(normalized({ mergeable: "UNKNOWN" })).denials.some((d) => d.code === "mergeability_unknown"));
  assert.ok(evaluateReadiness(normalized({ state: "CLOSED" })).denials.some((d) => d.code === "pull_request_not_open"));
  assert.equal(evaluateReadiness(normalized({ state: "MERGED" })).alreadyMerged, true);
});

test("unreported and pending checks block a plain merge", () => {
  assert.deepEqual(
    evaluateReadiness(normalized({ checks: [] })).denials.map((denial) => denial.code),
    ["checks_not_reported"],
  );
  assert.deepEqual(
    evaluateReadiness(normalized({ checks: [greenCheck(), pendingCheck()] })).denials.map((denial) => denial.code),
    ["checks_not_green"],
  );
});

test("--auto tolerates pending checks but never a failed one", () => {
  assert.deepEqual(evaluateReadiness(normalized({ checks: [greenCheck(), pendingCheck()] }), { auto: true }).denials, []);
  assert.deepEqual(evaluateReadiness(normalized({ checks: [] }), { auto: true }).denials, []);
  assert.deepEqual(
    evaluateReadiness(normalized({ checks: [failedCheck()] }), { auto: true }).denials.map((denial) => denial.code),
    ["checks_failed"],
    "arming auto-merge behind a red check would strand the pull request",
  );
});

test("runMerge squash-merges through the REST transport pinned to the validated head", () => {
  const gh = ghStub([{ payload: pullRequestPayload() }, { payload: pullRequestPayload() }, { stdout: "{}" }]);

  const { code, out } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_OK);
  assert.match(out, /MERGED: paperclipai\/paperclip#12158/);
  assert.deepEqual(gh.transportCalls(), [
    buildRestMergeArgs({ owner: "paperclipai", name: "paperclip", number: 12158, sha: HEAD }),
  ]);
});

test("runMerge re-validates and refuses when the head moves between reads", () => {
  const gh = ghStub([{ payload: pullRequestPayload() }, { payload: pullRequestPayload({ headRefOid: NEXT_HEAD }) }]);

  const { code, err } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_DENIED);
  assert.match(err, /moved from 111111111111 to 222222222222/);
  assert.deepEqual(gh.transportCalls(), [], "no merge may be attempted once the pinned head is stale");
});

test("runMerge refuses when the approval is dismissed between reads", () => {
  const gh = ghStub([
    { payload: pullRequestPayload() },
    {
      payload: pullRequestPayload({
        reviews: [{ state: "DISMISSED", submittedAt: "2026-08-25T11:00:00Z", author: { login: "reviewer" }, commit: { oid: HEAD } }],
      }),
    },
  ]);

  const { code, err } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_DENIED);
  assert.match(err, /missing_independent_approval/);
  assert.deepEqual(gh.transportCalls(), []);
});

test("runMerge denies an ungated pull request before touching any transport", () => {
  const gh = ghStub([{ payload: pullRequestPayload({ checks: [pendingCheck()] }) }]);

  const { code, err } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_DENIED);
  assert.match(err, /checks_not_green/);
  assert.deepEqual(gh.transportCalls(), []);
});

test("--auto arms GitHub auto-merge with the pinned expected head", () => {
  const gh = ghStub([
    { payload: pullRequestPayload({ checks: [pendingCheck()] }) },
    { payload: pullRequestPayload({ checks: [pendingCheck()] }) },
    { stdout: "{}" },
  ]);

  const { code, out } = silentRun(["merge", "12158", "--auto", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_OK);
  assert.match(out, /ARMED: paperclipai\/paperclip#12158/);
  assert.deepEqual(gh.transportCalls(), [
    buildAutoMergeArgs({ pullRequestId: "PR_node_id", expectedHeadOid: HEAD }),
  ]);
});

test("--dry-run reports the verdict without calling a transport", () => {
  const gh = ghStub([{ payload: pullRequestPayload() }]);

  const { code, out } = silentRun(["merge", "12158", "--dry-run", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_OK);
  assert.match(out, /DRY RUN/);
  assert.deepEqual(gh.transportCalls(), []);
});

test("an already-merged pull request is a success no-op", () => {
  const gh = ghStub([{ payload: pullRequestPayload({ state: "MERGED" }) }]);

  const { code, out } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_OK);
  assert.match(out, /already MERGED/);
  assert.deepEqual(gh.transportCalls(), []);
});

test("a masked permission denial is reported as a transport problem, not a gate failure", () => {
  const gh = ghStub([
    { payload: pullRequestPayload() },
    { payload: pullRequestPayload() },
    { status: 1, stderr: "gh: Not Found (HTTP 404)" },
  ]);

  const { code, err } = silentRun(["merge", "12158", "--repo", "paperclipai/paperclip"], gh);

  assert.equal(code, EXIT_ERROR);
  assert.match(err, /masks permission denials as 404/);
  assert.match(err, /Do not fall back to `gh pr merge`/);
});

test("classifyTransportFailure separates permission, staleness, and mergeability", () => {
  assert.equal(classifyTransportFailure("gh: Not Found (HTTP 404)").code, "transport_unavailable");
  assert.equal(classifyTransportFailure("HTTP 409: Head branch was modified").code, "head_moved");
  assert.equal(classifyTransportFailure("HTTP 405: Pull Request is not mergeable").code, "not_mergeable");
  assert.equal(classifyTransportFailure("Auto merge is already enabled").code, "auto_merge_already_armed");
});

test("usage errors exit distinctly from gate denials", () => {
  const { code } = silentRun(["merge", "12158", "--admin"], ghStub([]));
  assert.equal(code, EXIT_USAGE);
});

test("the guarded path never shells out to `gh pr merge`", () => {
  const source = readFileSync(LANE_SOURCE_PATH, "utf8");
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The deny is on the *invocation*, so assert on the shapes that could invoke
  // it. `gh pr merge` still appears in operator-facing prose, which is the
  // point: the guard tells you not to reach for it.
  assert.doesNotMatch(executable, /["'`]pr["'`]/, "no code path may pass `pr` as a gh subcommand");
  assert.doesNotMatch(executable, /shell:\s*true/, "no code path may hand a command string to a shell");

  const spawns = executable.match(/spawnSync\(\s*[^)]*/g) ?? [];
  assert.equal(spawns.length, 1, "there is exactly one process boundary in the guard");
  assert.match(spawns[0], /spawnSync\(\s*"gh",\s*args/, "that boundary passes an argv array built by this module");

  for (const args of [
    buildRestMergeArgs({ owner: "o", name: "n", number: 1, sha: HEAD }),
    buildAutoMergeArgs({ pullRequestId: "id", expectedHeadOid: HEAD }),
  ]) {
    assert.equal(args[0], "api", "every transport goes through `gh api`");
  }
});

test("the REST transport pins the merge method and the sha", () => {
  const args = buildRestMergeArgs({ owner: "paperclipai", name: "paperclip", number: 12158, sha: HEAD });
  assert.deepEqual(args, [
    "api",
    "--method",
    "PUT",
    "repos/paperclipai/paperclip/pulls/12158/merge",
    "-f",
    "merge_method=squash",
    "-f",
    `sha=${HEAD}`,
  ]);
});
