#!/usr/bin/env node
// Merge a pull request only when QA and Security have both signed off at the
// exact current head SHA (AUT-2230).
//
// Why this exists: AUT-2230 was not honoured on PR #164. The merge was fired by
// `gh pr merge 164 --auto --squash`, and on CannonFodder151/autobrainservice-website
// `--auto` merges on contact instead of queueing: the repo is private on the
// free plan, so branch protection, rulesets and the merge queue all return 403
// "Upgrade to GitHub Pro or make this repository public to enable this feature."
// Nothing on GitHub's side can block that call, so the precondition is enforced
// here instead.
//
// `--auto` is deliberately never used. On a repo with no branch protection it is
// not a gate, it is an immediate merge.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Markers are deliberately broad: the SHA check below is the real control, so a
// sign-off phrased the way a reviewer actually writes it still counts, and only
// counts at the head it names. Requiring the literal token `qa-approved` made the
// gate report MISSING against real sign-offs, which pushed the reviewer to bypass
// the gate instead of rerunning it (AUT-5537, PR CannonFodder151/autobrain-mobile#127).
const ROLES = [
  {
    id: "qa",
    label: "QA",
    markers: [
      "qa-approved",
      "qa_approved",
      "qa approved",
      "qa sign-off",
      "qa signoff",
      "qa sign off",
      "qa verdict",
      "qa re-verification",
      "qa re-verified",
    ],
  },
  {
    id: "security",
    label: "Security",
    markers: [
      "security-approved",
      "security_approved",
      "security approved",
      "security sign-off",
      "security signoff",
      "security sign off",
      "security verdict",
      "security re-verification",
      "security re-verified",
    ],
  },
];

// A sign-off is only valid for the head it was written against, so the comment
// must name a SHA that actually is (or prefixes) the current head. PR #164
// merged at 98ebddf while the only approvals named 9aef067.
export function shaReferencesHead(text, headSha) {
  const head = String(headSha ?? "").toLowerCase();
  if (head.length < 7) return false;
  const normalized = String(text ?? "").toLowerCase();
  for (const token of normalized.match(/\b[0-9a-f]{7,40}\b/g) ?? []) {
    if (head.startsWith(token) || token.startsWith(head)) return true;
  }
  return false;
}

export function evaluateGate({ headSha, comments }) {
  const results = ROLES.map((role) => {
    const marker = role.markers.find((candidate) =>
      comments.some((comment) => String(comment.body ?? "").toLowerCase().includes(candidate)),
    );
    const atHead = marker
      ? comments.find(
          (comment) =>
            String(comment.body ?? "").toLowerCase().includes(marker) &&
            shaReferencesHead(comment.body, headSha),
        )
      : null;
    return {
      role: role.id,
      label: role.label,
      satisfied: Boolean(atHead),
      marker: marker ?? null,
      source: atHead ? `${atHead.source}${atHead.createdAt ? ` @ ${atHead.createdAt}` : ""}` : null,
    };
  });
  const missing = results.filter((result) => !result.satisfied);
  return { headSha, results, missing, ok: missing.length === 0 };
}

function normalizeRepository(value) {
  const match = String(value).match(/(?:github\.com[/:])?([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Invalid GitHub repository: ${value}`);
  return `${match[1]}/${match[2]}`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

const GH_JSON_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: GH_JSON_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `gh ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ghJson(args) {
  const { stdout } = gh(args);
  return JSON.parse(stdout);
}

// Never pipe gh through a pager/filter: the PR #164 merge was masked by
// `2>&1 | tail -5`, which discarded the exit code and the error text.
function ghChecked(args) {
  const result = gh(args);
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// `gh api --paginate --jq` concatenates pages with no separator, which is not
// valid JSON. Page explicitly, like check-readiness.mjs does.
function ghPage(path, map) {
  const collected = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = ghJson(["api", `${path}${separator}per_page=100&page=${page}`]);
    const rows = (Array.isArray(batch) ? batch : []).map(map);
    collected.push(...rows);
    if (rows.length < 100) return collected;
  }
}

function pullRequestComments(repository, number) {
  const issueComments = ghPage(
    `repos/${repository}/issues/${number}/comments`,
    (comment) => ({
      createdAt: comment.created_at ?? null,
      author: comment.user?.login ?? null,
      body: comment.body,
      source: "pr",
    }),
  );
  const reviews = ghPage(`repos/${repository}/pulls/${number}/reviews`, (review) => ({
    createdAt: review.submitted_at ?? null,
    author: review.user?.login ?? null,
    body: review.body,
    source: `review:${review.state}`,
  }));
  return [...issueComments, ...reviews].filter((comment) => comment.body);
}

async function paperclipComments(origin) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("--origin needs PAPERCLIP_API_URL and PAPERCLIP_API_KEY");
  }
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const call = async (path) => {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api${path}`, { headers });
    if (!response.ok) throw new Error(`Paperclip GET ${path} failed (${response.status})`);
    return response.json();
  };

  const listing = await call(`/companies/${companyId}/issues?identifier=${encodeURIComponent(origin)}`);
  const issues = (Array.isArray(listing) ? listing : listing.issues ?? listing.data ?? []).filter(
    (issue) => issue.identifier === origin,
  );
  const issue = issues[0];
  if (!issue) throw new Error(`No Paperclip issue found for ${origin}`);

  const comments = await call(`/issues/${issue.id}/comments`);
  const rows = Array.isArray(comments) ? comments : comments.comments ?? comments.data ?? [];
  return rows
    .filter((comment) => comment.body)
    .map((comment) => ({
      createdAt: comment.createdAt ?? null,
      author: comment.authorAgentId ?? comment.authorUserId ?? null,
      body: comment.body,
      source: `paperclip:${origin}`,
    }));
}

function report(gate, { prUrl }) {
  process.stdout.write(`head ${gate.headSha}\n`);
  for (const result of gate.results) {
    const state = result.satisfied ? "OK" : "MISSING";
    process.stdout.write(`  [${state}] ${result.label}${result.source ? ` via ${result.source}` : ""}\n`);
  }
  if (!gate.ok) {
    process.stdout.write(
      `\nAUT-2230 gate NOT satisfied for ${prUrl}. Missing: ${gate.missing
        .map((entry) => entry.label)
        .join(", ")} at ${gate.headSha}.\nNo merge was performed.\n`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = normalizeRepository(args.repo ?? ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner);
  const number = Number(args.pr);
  if (!Number.isInteger(number) || number <= 0) throw new Error("--pr <number> is required");
  const prUrl = `https://github.com/${repository}/pull/${number}`;

  const pullRequest = ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repository,
    "--json",
    "state,headRefOid",
  ]);
  if (pullRequest.state !== "OPEN") {
    throw new Error(`${prUrl} is ${pullRequest.state}, not OPEN; refusing to merge`);
  }
  const headSha = pullRequest.headRefOid;

  const comments = [...pullRequestComments(repository, number)];
  if (args.origin) comments.push(...(await paperclipComments(args.origin)));

  const gate = evaluateGate({ headSha, comments });
  report(gate, { prUrl });

  if (!gate.ok) {
    // Exit 2 so callers can distinguish "gate blocked the merge" from a crash.
    process.exitCode = 2;
    return;
  }
  if (args.dry_run) {
    process.stdout.write(`\nGate satisfied. --dry-run: not merging ${prUrl}.\n`);
    return;
  }

  // No --auto: on a repo without branch protection that merges immediately and
  // bypasses this gate entirely.
  ghChecked(["pr", "merge", String(number), "--repo", repository, "--squash"]);
  const after = ghJson(["pr", "view", String(number), "--repo", repository, "--json", "state,mergeCommit"]);
  if (after.state !== "MERGED") throw new Error(`${prUrl} is ${after.state} after merge, expected MERGED`);
  process.stdout.write(`\nMerged ${prUrl} at ${headSha} -> ${after.mergeCommit?.oid ?? "unknown"}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}