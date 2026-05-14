#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+/;
const ISSUE_ID_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const RELEASE_LABEL_RE = /^release:(major|minor|patch)$/;

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/release-readiness-audit.js [--repo <path>] [--out <path>] [--json] [--skip-ci-gate]",
      "",
      "Environment:",
      "  RELEASE_AUDIT_REPO_PATH  Path to the git repo to audit (alternative to --repo)",
      "  PAPERCLIP_API_URL        Paperclip API base URL (for label checks)",
      "  PAPERCLIP_API_KEY        Paperclip API bearer token",
      "  PAPERCLIP_COMPANY_ID     Company ID for issue queries",
      "",
      "Exit codes:",
      "  0  Release is ready",
      "  1  Audit itself failed (bad config, missing repo, etc.)",
      "  2  Blockers found (release not ready)",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    repo: process.env.RELEASE_AUDIT_REPO_PATH || "",
    out: "",
    json: false,
    skipCiGate: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--repo":
        options.repo = argv[++i] ?? "";
        break;
      case "--out":
        options.out = argv[++i] ?? "";
        break;
      case "--json":
        options.json = true;
        break;
      case "--skip-ci-gate":
        options.skipCiGate = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        process.stderr.write(`Unknown argument: ${argv[i]}\n`);
        usage();
        process.exit(1);
    }
  }

  return options;
}

function git(repoPath, ...args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function getLatestStableTag(repoPath) {
  try {
    const tags = git(repoPath, "tag", "--list", "v*", "--sort=-version:refname");
    if (!tags) return null;
    for (const tag of tags.split("\n")) {
      if (SEMVER_TAG_RE.test(tag.trim())) return tag.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function getCommitsSinceTag(repoPath, tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  try {
    const log = git(repoPath, "log", range, "--format=%H|%s");
    if (!log) return [];
    return log.split("\n").filter(Boolean).map((line) => {
      const sep = line.indexOf("|");
      return { sha: line.slice(0, sep), subject: line.slice(sep + 1) };
    });
  } catch {
    return [];
  }
}

function extractIssueIdentifiers(commits) {
  const ids = new Set();
  for (const commit of commits) {
    for (const match of commit.subject.matchAll(ISSUE_ID_RE)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

async function fetchIssueByIdentifier(identifier) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  if (!apiUrl || !apiKey || !companyId) return null;

  try {
    const url = `${apiUrl}/api/companies/${companyId}/issues?q=${encodeURIComponent(identifier)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const issues = data.issues ?? data;
    if (!Array.isArray(issues)) return null;
    return issues.find((i) => i.identifier === identifier) ?? null;
  } catch {
    return null;
  }
}

function checkReleaseLabels(issue) {
  const labels = (issue.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name ?? l.label ?? "",
  );
  const releaseLabels = labels.filter((l) => RELEASE_LABEL_RE.test(l));
  return {
    identifier: issue.identifier,
    title: issue.title ?? "",
    releaseLabels,
    allLabels: labels,
  };
}

function resolveVersionBump(issueLabelResults) {
  let bump = "patch";
  for (const r of issueLabelResults) {
    for (const label of r.releaseLabels) {
      const match = label.match(RELEASE_LABEL_RE);
      if (!match) continue;
      const level = match[1];
      if (level === "major") bump = "major";
      else if (level === "minor" && bump !== "major") bump = "minor";
    }
  }
  return bump;
}

function tryHygieneAudit(repoPath) {
  const hygieneScript = join(repoPath, "scripts", "repo-hygiene.js");
  if (!existsSync(hygieneScript)) {
    return { available: false, warning: "repo-hygiene.js not found (TEC-975 parallel work)" };
  }

  try {
    const output = execFileSync("node", [hygieneScript, "--audit-mode", "--json"], {
      encoding: "utf8",
      timeout: 60_000,
      cwd: repoPath,
    });
    return { available: true, result: JSON.parse(output) };
  } catch (err) {
    return {
      available: true,
      warning: `hygiene_failed: repo-hygiene.js crashed at runtime: ${err.message?.split("\n")[0] ?? "unknown error"}`,
    };
  }
}

function resolveGhPath() {
  try {
    execFileSync("which", ["gh"], { stdio: "pipe" });
    return "gh";
  } catch {
    // Fall through to check common install locations
  }
  const candidates = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function checkCiStatus(repoPath, skipCiGate) {
  if (skipCiGate) {
    return { skipped: true, status: "skipped" };
  }

  const ghPath = resolveGhPath();
  if (!ghPath) {
    return { skipped: false, status: "ci_unavailable" };
  }

  try {
    const output = execFileSync(
      ghPath,
      ["run", "list", "--branch", "main", "--limit", "1", "--json", "conclusion,status,name"],
      { encoding: "utf8", timeout: 30_000, cwd: repoPath },
    );
    const runs = JSON.parse(output);
    if (!runs.length) {
      return { skipped: false, status: "no_ci_runs", detail: "No CI runs found for main" };
    }
    const run = runs[0];
    if (run.status !== "completed") {
      return {
        skipped: false,
        status: "ci_in_progress",
        detail: `Latest run "${run.name}" is ${run.status}`,
      };
    }
    if (run.conclusion === "success") {
      return { skipped: false, status: "green", detail: `Latest run "${run.name}" passed` };
    }
    return {
      skipped: false,
      status: "ci_red",
      detail: `Latest run "${run.name}" concluded: ${run.conclusion}`,
    };
  } catch (err) {
    return {
      skipped: false,
      status: "ci_unavailable",
      detail: err.message?.split("\n")[0] ?? "gh command failed",
    };
  }
}

function buildProposalMarkdown(audit) {
  const lines = [];
  const now = new Date().toISOString().split("T")[0];

  if (audit.ci?.status === "ci_unavailable") {
    lines.push(
      "> **Warning: CI GATE UNAVAILABLE** — The `gh` CLI was not available in this environment. " +
        "CI status could not be verified. This audit fails closed on CI availability.",
    );
    lines.push("");
  }

  lines.push(`# Release Proposal — ${now}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  if (audit.ok) {
    lines.push(`Release is **ready**. Proposed version bump: **${audit.versionBump}**.`);
  } else {
    lines.push(`Release is **blocked** by ${audit.blockers.length} issue(s).`);
  }
  lines.push("");

  lines.push("## Baseline");
  lines.push("");
  lines.push(`- Latest tag: \`${audit.latestTag ?? "(none)"}\``);
  lines.push(`- Commits since tag: ${audit.commitCount}`);
  lines.push(`- Main HEAD: \`${audit.headSha?.slice(0, 10) ?? "unknown"}\``);
  lines.push(`- Referenced issues: ${audit.issueIdentifiers.length}`);
  lines.push("");

  if (audit.blockers.length > 0) {
    lines.push("## Blockers");
    lines.push("");
    for (const b of audit.blockers) {
      lines.push(
        `- **${b.code}**: ${b.message}${b.owner ? ` *(unblock: ${b.owner})*` : ""}`,
      );
      if (b.items?.length) {
        for (const item of b.items) {
          lines.push(`  - ${item}`);
        }
      }
    }
    lines.push("");
  }

  if (audit.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of audit.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  if (audit.issueLabels?.length) {
    lines.push("## Issues in Release");
    lines.push("");
    lines.push("| Issue | Title | Release Label |");
    lines.push("|-------|-------|---------------|");
    for (const il of audit.issueLabels) {
      const labelStr =
        il.releaseLabels.length > 0 ? il.releaseLabels.join(", ") : "*(none)*";
      lines.push(`| ${il.identifier} | ${il.title} | ${labelStr} |`);
    }
    lines.push("");
  }

  if (audit.commits?.length) {
    lines.push("## Commits");
    lines.push("");
    for (const c of audit.commits) {
      lines.push(`- \`${c.sha.slice(0, 10)}\` ${c.subject}`);
    }
    lines.push("");
  }

  lines.push("## CI Status");
  lines.push("");
  if (audit.ci?.skipped) {
    lines.push("CI gate was skipped (`--skip-ci-gate`).");
  } else if (audit.ci?.status === "green") {
    lines.push(`Pass: ${audit.ci.detail}`);
  } else {
    lines.push(`Fail: ${audit.ci?.detail ?? audit.ci?.status ?? "unknown"}`);
  }
  lines.push("");

  lines.push("## Hygiene");
  lines.push("");
  if (!audit.hygiene?.available) {
    lines.push(`Info: ${audit.hygiene?.warning ?? "Hygiene check not available"}`);
  } else if (audit.hygiene?.warning) {
    lines.push(`Warning: ${audit.hygiene.warning}`);
  } else if (audit.hygiene?.result?.orphans?.length > 0) {
    lines.push(
      `Found ${audit.hygiene.result.orphans.length} orphan branch(es):`,
    );
    for (const o of audit.hygiene.result.orphans) {
      lines.push(`- \`${o.branch ?? o}\` (issue: ${o.issue ?? "unknown"})`);
    }
  } else {
    lines.push("Pass: No hygiene issues detected.");
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.repo) {
    process.stderr.write(
      "Error: RELEASE_AUDIT_REPO_PATH is not set and --repo was not provided.\n" +
        "Set the environment variable or pass --repo <path> to the working tree of the repo to audit.\n",
    );
    process.exit(1);
  }

  const repoPath = resolve(options.repo);

  if (!existsSync(join(repoPath, ".git"))) {
    process.stderr.write(
      `Error: ${repoPath} is not a git repository (no .git directory found).\n`,
    );
    process.exit(1);
  }

  const audit = {
    ok: true,
    blockers: [],
    warnings: [],
    latestTag: null,
    headSha: null,
    commitCount: 0,
    commits: [],
    issueIdentifiers: [],
    issueLabels: [],
    versionBump: null,
    ci: null,
    hygiene: null,
  };

  try {
    audit.headSha = git(repoPath, "rev-parse", "HEAD");
  } catch {
    process.stderr.write(
      `Error: could not determine HEAD for ${repoPath}.\n`,
    );
    process.exit(1);
  }

  // 1. Baseline tag
  audit.latestTag = getLatestStableTag(repoPath);
  if (!audit.latestTag) {
    audit.ok = false;
    audit.blockers.push({
      code: "no_baseline_tag",
      message:
        "Repository has no v*.*.* tag yet — cannot determine release delta",
      owner: "Board",
    });
  }

  // 2. Nothing to release
  if (audit.latestTag) {
    let tagSha;
    try {
      tagSha = git(repoPath, "rev-parse", `${audit.latestTag}^{}`).trim();
    } catch {
      tagSha = git(repoPath, "rev-parse", audit.latestTag).trim();
    }

    if (tagSha === audit.headSha) {
      audit.ok = false;
      audit.blockers.push({
        code: "nothing_to_release",
        message: `main is at the latest tag (${audit.latestTag}) — nothing to release`,
      });
    }
  }

  // 3. Commits and issue identifiers
  const commits = getCommitsSinceTag(repoPath, audit.latestTag);
  audit.commits = commits;
  audit.commitCount = commits.length;
  audit.issueIdentifiers = extractIssueIdentifiers(commits);

  // 4. Release labels
  if (audit.issueIdentifiers.length > 0 && process.env.PAPERCLIP_API_URL) {
    const results = await Promise.all(
      audit.issueIdentifiers.map(async (id) => {
        const issue = await fetchIssueByIdentifier(id);
        if (!issue)
          return {
            identifier: id,
            title: "(not found)",
            releaseLabels: [],
            allLabels: [],
          };
        return checkReleaseLabels(issue);
      }),
    );
    audit.issueLabels = results;

    const missing = results.filter(
      (r) => r.releaseLabels.length === 0 && r.title !== "(not found)",
    );
    if (missing.length > 0) {
      audit.ok = false;
      audit.blockers.push({
        code: "release_labels_missing",
        message: `${missing.length} issue(s) since last tag have no release:* label`,
        owner: "Board / dev lead",
        items: missing.map((m) => `${m.identifier}: ${m.title}`),
      });
    }

    const multi = results.filter((r) => r.releaseLabels.length > 1);
    if (multi.length > 0) {
      audit.ok = false;
      audit.blockers.push({
        code: "release_labels_multiple",
        message: `${multi.length} issue(s) have conflicting release:* labels`,
        owner: "Board / dev lead",
        items: multi.map(
          (m) => `${m.identifier}: ${m.releaseLabels.join(", ")}`,
        ),
      });
    }

    const labeled = results.filter((r) => r.releaseLabels.length === 1);
    if (labeled.length > 0) {
      audit.versionBump = resolveVersionBump(labeled);
    }
  } else if (
    audit.issueIdentifiers.length === 0 &&
    audit.commitCount > 0 &&
    !audit.blockers.some((b) => b.code === "nothing_to_release")
  ) {
    audit.warnings.push(
      "No Paperclip issue identifiers found in commit messages — label check skipped. " +
        "Commits may use PR numbers (#NNN) instead of issue identifiers.",
    );
  }

  // 5. Hygiene
  audit.hygiene = tryHygieneAudit(repoPath);
  if (audit.hygiene.available && audit.hygiene.result?.orphans?.length > 0) {
    audit.ok = false;
    audit.blockers.push({
      code: "hygiene_orphans",
      message: `${audit.hygiene.result.orphans.length} fix/* branch(es) with done issues are unmerged`,
      owner: "Hygiene routine owner (TEC-975)",
      items: audit.hygiene.result.orphans.map((o) => `${o.branch ?? o}`),
    });
  }
  if (
    audit.hygiene.warning &&
    !audit.hygiene.warning.startsWith("repo-hygiene.js not found")
  ) {
    audit.warnings.push(audit.hygiene.warning);
  }

  // 6. CI gate
  audit.ci = checkCiStatus(repoPath, options.skipCiGate);
  if (audit.ci.status === "ci_unavailable") {
    audit.ok = false;
    audit.blockers.push({
      code: "ci_unavailable",
      message: `gh CLI not present or failed — CI gate could not run (fail-closed)${audit.ci.detail ? `: ${audit.ci.detail}` : ""}`,
      owner: "Ops / dev-lead",
    });
  } else if (audit.ci.status === "ci_red") {
    audit.ok = false;
    audit.blockers.push({
      code: "ci_red",
      message: `Last main CI run is not green: ${audit.ci.detail ?? "unknown"}`,
      owner: "CI owner",
    });
  }

  // Build outputs
  const proposal = buildProposalMarkdown(audit);

  if (options.out) {
    writeFileSync(options.out, proposal, "utf8");
    process.stderr.write(`Proposal written to ${options.out}\n`);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
  } else if (!options.out) {
    process.stdout.write(proposal);
  }

  process.exit(audit.ok ? 0 : 2);
}

main().catch((err) => {
  process.stderr.write(`Audit failed: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
