#!/usr/bin/env node
/**
 * lane.mjs
 *
 * Repository-standard guarded pull-request merge command.
 *
 *   node .claude/scripts/lane.mjs merge <PR_NUMBER> [--auto] [--repo owner/name]
 *                                                   [--dry-run] [--json]
 *
 * The guard exists because a merge is the one irreversible step in the delivery
 * path: it publishes code to the default branch under the operator's identity.
 * Every gate below is checked against a *pinned* head SHA, re-validated
 * immediately before the transport runs, and finally handed to GitHub with that
 * same SHA so GitHub itself rejects the merge if the head moved in between.
 *
 * Gates (all must pass):
 *   - the pull request is OPEN and not a draft
 *   - the branch is not conflicting
 *   - at least one APPROVED review from someone other than the PR author, filed
 *     against the pinned head SHA (an approval on an older commit is stale)
 *   - no outstanding CHANGES_REQUESTED review
 *   - required checks have REPORTED green on the pinned head SHA
 *     (`--auto` relaxes *pending/unreported* checks only — see below)
 *
 * `--auto` is the only documented behavior modifier and means exactly one
 * thing: instead of merging now, arm GitHub's native auto-merge (squash) so the
 * merge fires when required checks finish. Approval and head pinning are still
 * enforced up front, and a check that has already FAILED still blocks, because
 * an armed auto-merge behind a red check never fires and silently strands the
 * pull request. There is no admin/bypass/force flag and no merge method other
 * than squash.
 *
 * Transport: this command talks to the GitHub REST/GraphQL API through
 * `gh api`. It never invokes `gh pr merge` — that command is denied at the
 * repository level precisely because it can merge without these gates, and the
 * guarded path must not become a way around its own deny.
 *
 * See doc/GUARDED-PR-MERGE.md for the operator runbook.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MERGE_METHOD = "squash";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_DENIED = 3;

/**
 * Flags that would defeat the guard. They are rejected by name so an operator
 * who reaches for a familiar `gh pr merge` flag gets an explanation instead of
 * a silent no-op.
 */
export const DENIED_FLAGS = new Map([
  ["--admin", "administrator merge bypasses branch protection"],
  ["--merge", `only ${MERGE_METHOD} merges are permitted`],
  ["--rebase", `only ${MERGE_METHOD} merges are permitted`],
  ["--squash", `${MERGE_METHOD} is already the only merge method; the flag is redundant`],
  ["--force", "there is no force path through the guard"],
  ["--body", "squash commit bodies come from the pull request, not the operator"],
  ["--match-head-commit", "the head SHA is pinned by the command itself"],
]);

const USAGE = [
  "usage: node .claude/scripts/lane.mjs merge <PR_NUMBER> [--auto] [--repo owner/name] [--dry-run] [--json]",
  "",
  "  --auto             arm GitHub auto-merge (squash) instead of merging now; pending",
  "                     required checks are tolerated, already-failed checks are not",
  "  --repo owner/name  target repository (default: GH_REPO, else the current checkout)",
  "  --dry-run          evaluate every gate and report the verdict without merging",
  "  --json             emit the machine-readable result on stdout",
].join("\n");

const GREEN_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const GREEN_STATUS_STATES = new Set(["SUCCESS"]);
const FAILED_STATUS_STATES = new Set(["FAILURE", "ERROR"]);

const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

const PULL_REQUEST_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id
      number
      title
      state
      isDraft
      mergeable
      mergeStateStatus
      baseRefName
      headRefOid
      author{login}
      reviews(last:100){nodes{state submittedAt author{login} commit{oid}}}
      commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(last:100){nodes{
        __typename
        ... on CheckRun{name status conclusion}
        ... on StatusContext{context state}
      }}}}}}
    }
  }
}`;

const ENABLE_AUTO_MERGE_MUTATION = `mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){
  enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:SQUASH,expectedHeadOid:$expectedHeadOid}){
    pullRequest{number autoMergeRequest{enabledAt mergeMethod}}
  }
}`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }
  if (command !== "merge") {
    throw new UsageError(`unknown command \`${command}\`. The only supported command is \`merge\`.`);
  }

  const options = { command: "merge", prNumber: null, auto: false, repo: null, dryRun: false, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (DENIED_FLAGS.has(arg)) {
      throw new UsageError(`\`${arg}\` is not available on the guarded merge path: ${DENIED_FLAGS.get(arg)}.`);
    }

    if (arg === "--auto") {
      options.auto = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      const value = arg.startsWith("--repo=") ? arg.slice("--repo=".length) : rest[(index += 1)];
      if (!value) throw new UsageError("`--repo` requires an `owner/name` value.");
      if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new UsageError(`\`--repo\` expects \`owner/name\`, got \`${value}\`.`);
      options.repo = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag \`${arg}\`.`);
    }

    if (options.prNumber !== null) {
      throw new UsageError(`unexpected argument \`${arg}\`; \`merge\` takes exactly one pull-request number.`);
    }
    const parsed = Number(arg.replace(/^#/, ""));
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new UsageError(`\`${arg}\` is not a pull-request number.`);
    }
    options.prNumber = parsed;
  }

  if (options.prNumber === null) throw new UsageError("`merge` requires a pull-request number.");
  return options;
}

export class UsageError extends Error {}

export function normalizePullRequest(payload) {
  const pullRequest = payload?.data?.repository?.pullRequest;
  if (!pullRequest) throw new Error("GitHub returned no pull request for that number.");

  const headCommit = pullRequest.commits?.nodes?.[0]?.commit ?? null;
  const contexts = headCommit?.statusCheckRollup?.contexts?.nodes ?? [];

  return {
    id: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title ?? "",
    state: pullRequest.state,
    isDraft: Boolean(pullRequest.isDraft),
    mergeable: pullRequest.mergeable ?? "UNKNOWN",
    mergeStateStatus: pullRequest.mergeStateStatus ?? "UNKNOWN",
    baseRefName: pullRequest.baseRefName,
    headRefOid: pullRequest.headRefOid,
    authorLogin: pullRequest.author?.login ?? null,
    reviews: (pullRequest.reviews?.nodes ?? []).map((review) => ({
      state: review.state,
      submittedAt: review.submittedAt ?? null,
      login: review.author?.login ?? null,
      commitOid: review.commit?.oid ?? null,
    })),
    checks: contexts.map((context) => normalizeCheckContext(context)),
  };
}

function normalizeCheckContext(context) {
  if (context.__typename === "StatusContext") {
    const state = context.state ?? "PENDING";
    return {
      name: context.context ?? "status",
      state,
      verdict: GREEN_STATUS_STATES.has(state)
        ? "green"
        : FAILED_STATUS_STATES.has(state)
          ? "failed"
          : "pending",
    };
  }

  const status = context.status ?? "QUEUED";
  const conclusion = context.conclusion ?? null;
  const reported = status === "COMPLETED";
  return {
    name: context.name ?? "check",
    state: reported ? (conclusion ?? "COMPLETED") : status,
    verdict: !reported
      ? "pending"
      : GREEN_CHECK_CONCLUSIONS.has(conclusion)
        ? "green"
        : FAILED_CHECK_CONCLUSIONS.has(conclusion)
          ? "failed"
          : "pending",
  };
}

export function summarizeChecks(checks) {
  const green = [];
  const failed = [];
  const pending = [];
  for (const check of checks) {
    if (check.verdict === "green") green.push(check);
    else if (check.verdict === "failed") failed.push(check);
    else pending.push(check);
  }
  return { total: checks.length, green, failed, pending };
}

/**
 * Reduce the review list to one opinionated verdict per reviewer. A later
 * `COMMENTED` review must not erase an earlier approval, and a `DISMISSED`
 * review must erase it.
 */
export function summarizeReviews(reviews, { authorLogin, headOid }) {
  const latestByReviewer = new Map();

  for (const review of reviews) {
    if (!OPINIONATED_REVIEW_STATES.has(review.state)) continue;
    if (!review.login) continue;
    const previous = latestByReviewer.get(review.login);
    if (previous && (previous.submittedAt ?? "") > (review.submittedAt ?? "")) continue;
    latestByReviewer.set(review.login, review);
  }

  const verdicts = [...latestByReviewer.values()];
  const independent = verdicts.filter((review) => review.login !== authorLogin);

  return {
    changesRequestedBy: independent.filter((review) => review.state === "CHANGES_REQUESTED").map((r) => r.login),
    approvals: independent.filter((review) => review.state === "APPROVED" && review.commitOid === headOid),
    staleApprovals: independent.filter((review) => review.state === "APPROVED" && review.commitOid !== headOid),
  };
}

/**
 * Evaluate every gate against a single snapshot. Pure: the caller decides what
 * to do with the denials, which is what makes the pinning/re-validation
 * sequence testable without a network.
 */
export function evaluateReadiness(pullRequest, { auto = false } = {}) {
  const denials = [];
  const checks = summarizeChecks(pullRequest.checks);
  const reviews = summarizeReviews(pullRequest.reviews, {
    authorLogin: pullRequest.authorLogin,
    headOid: pullRequest.headRefOid,
  });

  if (pullRequest.state === "MERGED") {
    return { alreadyMerged: true, denials: [], checks, reviews, pinnedHead: pullRequest.headRefOid };
  }
  if (pullRequest.state !== "OPEN") {
    denials.push({ code: "pull_request_not_open", message: `pull request is ${pullRequest.state}, not OPEN.` });
  }
  if (pullRequest.isDraft) {
    denials.push({ code: "draft_pull_request", message: "pull request is a draft." });
  }
  if (pullRequest.mergeable === "CONFLICTING") {
    denials.push({ code: "merge_conflict", message: `head conflicts with \`${pullRequest.baseRefName}\`.` });
  }
  if (pullRequest.mergeable === "UNKNOWN") {
    denials.push({
      code: "mergeability_unknown",
      message: "GitHub has not finished computing mergeability for this head; retry shortly.",
    });
  }

  if (reviews.changesRequestedBy.length > 0) {
    denials.push({
      code: "changes_requested",
      message: `unresolved CHANGES_REQUESTED review from ${reviews.changesRequestedBy.join(", ")}.`,
    });
  }
  if (reviews.approvals.length === 0) {
    denials.push(
      reviews.staleApprovals.length > 0
        ? {
            code: "stale_approval",
            message:
              `the only independent approval (${reviews.staleApprovals.map((r) => r.login).join(", ")}) ` +
              `was filed against an older commit, not the pinned head ${short(pullRequest.headRefOid)}; re-request review.`,
          }
        : {
            code: "missing_independent_approval",
            message: `no APPROVED review on ${short(pullRequest.headRefOid)} from someone other than the author (${pullRequest.authorLogin ?? "unknown"}).`,
          },
    );
  }

  if (checks.failed.length > 0) {
    denials.push({
      code: "checks_failed",
      message: `failed check(s) on ${short(pullRequest.headRefOid)}: ${checks.failed.map(describeCheck).join(", ")}.`,
    });
  }
  if (!auto) {
    if (checks.total === 0) {
      denials.push({
        code: "checks_not_reported",
        message: `no checks have reported on ${short(pullRequest.headRefOid)}; unreported is not green.`,
      });
    } else if (checks.pending.length > 0) {
      denials.push({
        code: "checks_not_green",
        message:
          `check(s) still pending on ${short(pullRequest.headRefOid)}: ${checks.pending.map(describeCheck).join(", ")}. ` +
          "Wait for green, or pass --auto when the issue authorizes waiting.",
      });
    }
  }

  return { alreadyMerged: false, denials, checks, reviews, pinnedHead: pullRequest.headRefOid };
}

function describeCheck(check) {
  return `${check.name} (${check.state})`;
}

function short(oid) {
  return typeof oid === "string" ? oid.slice(0, 12) : String(oid);
}

export function buildPullRequestQueryArgs({ owner, name, number }) {
  return [
    "api",
    "graphql",
    "-f",
    `query=${PULL_REQUEST_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ];
}

/**
 * REST merge transport. Deliberately not `gh pr merge`: the pinned `sha` makes
 * GitHub reject the call if the head moved after the last re-validation.
 */
export function buildRestMergeArgs({ owner, name, number, sha }) {
  return [
    "api",
    "--method",
    "PUT",
    `repos/${owner}/${name}/pulls/${number}/merge`,
    "-f",
    `merge_method=${MERGE_METHOD}`,
    "-f",
    `sha=${sha}`,
  ];
}

export function buildAutoMergeArgs({ pullRequestId, expectedHeadOid }) {
  return [
    "api",
    "graphql",
    "-f",
    `query=${ENABLE_AUTO_MERGE_MUTATION}`,
    "-f",
    `pullRequestId=${pullRequestId}`,
    "-f",
    `expectedHeadOid=${expectedHeadOid}`,
  ];
}

/**
 * GitHub masks "you lack write access" as 404 on the merge endpoint, which is
 * exactly the failure EZEAA-871 spent a day diagnosing. Name it explicitly.
 */
export function classifyTransportFailure(stderr = "") {
  if (/\b(?:HTTP )?40[34]\b/.test(stderr) || /not found/i.test(stderr) || /must have (?:admin|write) access/i.test(stderr)) {
    return {
      code: "transport_unavailable",
      message:
        "GitHub refused the merge for this identity (403/404 — GitHub masks permission denials as 404). " +
        "The gates passed; only the transport is blocked. Route the merge to an identity with `push` on the " +
        "repository, or have the repository owner grant it. Do not fall back to `gh pr merge`.",
    };
  }
  if (/head (?:branch|sha) .*(?:modified|changed)/i.test(stderr) || /\b409\b/.test(stderr)) {
    return {
      code: "head_moved",
      message: "GitHub rejected the merge because the head moved after validation. Re-run the command.",
    };
  }
  if (/\b405\b/.test(stderr) || /not mergeable/i.test(stderr)) {
    return { code: "not_mergeable", message: "GitHub reports the pull request is not mergeable in its current state." };
  }
  if (/auto[- ]merge is already|already enabled/i.test(stderr)) {
    return { code: "auto_merge_already_armed", message: "auto-merge was already armed on this pull request." };
  }
  return { code: "transport_failed", message: stderr.trim() || "the GitHub transport failed without output." };
}

function defaultGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    return { status: 127, stdout: "", stderr: `failed to run \`gh\`: ${result.error.message}` };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolveRepo({ explicit, gh }) {
  const candidate = explicit ?? process.env.GH_REPO ?? null;
  if (candidate) {
    const [owner, name] = candidate.split("/");
    return { owner, name };
  }
  const result = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (result.status !== 0) {
    throw new Error(
      `could not determine the target repository: ${result.stderr.trim() || "gh repo view failed"}. Pass --repo owner/name.`,
    );
  }
  const [owner, name] = result.stdout.trim().split("/");
  if (!owner || !name) throw new Error(`could not parse repository \`${result.stdout.trim()}\`. Pass --repo owner/name.`);
  return { owner, name };
}

function fetchPullRequest({ gh, owner, name, number }) {
  const result = gh(buildPullRequestQueryArgs({ owner, name, number }));
  if (result.status !== 0) {
    throw new Error(`could not read ${owner}/${name}#${number}: ${result.stderr.trim() || "gh api graphql failed"}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub returned a response that is not JSON for ${owner}/${name}#${number}.`);
  }
  return normalizePullRequest(payload);
}

function reportDenials({ denials, error, pullRequest }) {
  error(`REFUSED: ${pullRequest.number} is not eligible for a guarded merge.\n`);
  for (const denial of denials) error(`  ✗  [${denial.code}] ${denial.message}`);
  error("\nNo merge was attempted. Fix the conditions above and re-run the command.");
}

export function runMerge({ argv, gh = defaultGh, log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (usageError) {
    if (!(usageError instanceof UsageError)) throw usageError;
    error(`error: ${usageError.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (options.command === "help") {
    log(USAGE);
    return EXIT_OK;
  }

  let owner;
  let name;
  try {
    ({ owner, name } = resolveRepo({ explicit: options.repo, gh }));
  } catch (resolveError) {
    error(`error: ${resolveError.message}`);
    return EXIT_ERROR;
  }

  const target = `${owner}/${name}#${options.prNumber}`;
  const emit = (result) => {
    if (options.json) log(JSON.stringify(result, null, 2));
    return result;
  };

  // Snapshot 1: pin the head and evaluate every gate against it.
  let pinned;
  try {
    pinned = fetchPullRequest({ gh, owner, name, number: options.prNumber });
  } catch (fetchError) {
    error(`error: ${fetchError.message}`);
    return EXIT_ERROR;
  }

  const pinnedHead = pinned.headRefOid;
  const readiness = evaluateReadiness(pinned, { auto: options.auto });

  if (readiness.alreadyMerged) {
    log(`${target} is already MERGED at ${short(pinnedHead)}; nothing to do.`);
    emit({ target, outcome: "already_merged", head: pinnedHead });
    return EXIT_OK;
  }

  if (readiness.denials.length > 0) {
    reportDenials({ denials: readiness.denials, error, pullRequest: pinned });
    emit({ target, outcome: "denied", head: pinnedHead, denials: readiness.denials });
    return EXIT_DENIED;
  }

  log(`${target} pinned at ${short(pinnedHead)}`);
  log(`  ✓  approved by ${readiness.reviews.approvals.map((review) => review.login).join(", ")} on the pinned head`);
  log(
    readiness.checks.total === 0
      ? "  ·  no checks reported yet (tolerated under --auto)"
      : `  ✓  ${readiness.checks.green.length}/${readiness.checks.total} check(s) green` +
          (readiness.checks.pending.length > 0 ? `, ${readiness.checks.pending.length} pending (tolerated under --auto)` : ""),
  );

  if (options.dryRun) {
    log(`\nDRY RUN: ${target} would be ${options.auto ? "armed for auto-merge" : "squash-merged"} at ${short(pinnedHead)}.`);
    emit({ target, outcome: "dry_run", head: pinnedHead, auto: options.auto });
    return EXIT_OK;
  }

  // Snapshot 2: re-validate immediately before the transport. A push, a
  // dismissed approval, or a newly-red check between the two reads must abort.
  let current;
  try {
    current = fetchPullRequest({ gh, owner, name, number: options.prNumber });
  } catch (fetchError) {
    error(`error: re-validation read failed, no merge attempted: ${fetchError.message}`);
    return EXIT_ERROR;
  }

  if (current.headRefOid !== pinnedHead) {
    error(
      `REFUSED: ${target} moved from ${short(pinnedHead)} to ${short(current.headRefOid)} during validation. ` +
        "No merge was attempted; re-run the command against the new head.",
    );
    emit({ target, outcome: "denied", head: pinnedHead, denials: [{ code: "head_moved", message: "head changed during validation." }] });
    return EXIT_DENIED;
  }

  const revalidated = evaluateReadiness(current, { auto: options.auto });
  if (revalidated.alreadyMerged) {
    log(`${target} was merged by someone else during validation; nothing to do.`);
    emit({ target, outcome: "already_merged", head: pinnedHead });
    return EXIT_OK;
  }
  if (revalidated.denials.length > 0) {
    error(`REFUSED: ${target} stopped meeting the gates during validation.\n`);
    for (const denial of revalidated.denials) error(`  ✗  [${denial.code}] ${denial.message}`);
    emit({ target, outcome: "denied", head: pinnedHead, denials: revalidated.denials });
    return EXIT_DENIED;
  }

  const transport = options.auto
    ? gh(buildAutoMergeArgs({ pullRequestId: current.id, expectedHeadOid: pinnedHead }))
    : gh(buildRestMergeArgs({ owner, name, number: options.prNumber, sha: pinnedHead }));

  if (transport.status !== 0) {
    const failure = classifyTransportFailure(transport.stderr);
    if (failure.code === "auto_merge_already_armed") {
      log(`${target} already has auto-merge armed at ${short(pinnedHead)}.`);
      emit({ target, outcome: "auto_merge_armed", head: pinnedHead });
      return EXIT_OK;
    }
    error(`ERROR: ${failure.message}`);
    emit({ target, outcome: "transport_failed", head: pinnedHead, failure });
    return EXIT_ERROR;
  }

  if (options.auto) {
    log(`ARMED: ${target} will squash-merge at ${short(pinnedHead)} once required checks pass.`);
    log("Re-read the pull request to confirm it is armed or merged; command success alone is not delivery evidence.");
    emit({ target, outcome: "auto_merge_armed", head: pinnedHead });
    return EXIT_OK;
  }

  log(`MERGED: ${target} squash-merged at ${short(pinnedHead)}.`);
  emit({ target, outcome: "merged", head: pinnedHead });
  return EXIT_OK;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runMerge({ argv: process.argv.slice(2) }));
}
