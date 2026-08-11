#!/usr/bin/env node
// check-public-portability.mjs
//
// Fails (exit 1) if a prohibited "internal" marker appears in the ADDED lines
// or the changed file paths of a git diff range. Intended as a portability gate
// before a repo (or a slice of it) is published to a public remote.
//
// Usage:
//   node scripts/check-public-portability.mjs <git-diff-range>
//   node scripts/check-public-portability.mjs origin/master...HEAD
//
// Exit codes:
//   0  no prohibited markers found
//   1  one or more prohibited markers found (per-match report printed)
//   2  usage error (missing range argument)
//
// Self-contained: depends only on node:child_process and node:fs.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const SELF_BASENAME = "check-public-portability.mjs";

// Prohibited content markers. Each is { name, re, contentOnly?, skipTest? }.
//  - re          : RegExp tested against a line of added content and/or a path.
//  - contentOnly : only test added content, not file paths.
//  - skipTest    : do not flag when the containing file looks like test source.
const CONTENT_MARKERS = [
  { name: "internal-issue-id", re: /(?<![A-Za-z0-9])sag[-_]?\d+(?![A-Za-z0-9])/i },
  {
    name: "bare-uuid",
    re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
  { name: "internal-agent-link", re: /agent:\/\// },
  { name: "internal-host-or-url", re: /paperclip\.ing|paperclipai|\.paperclip\b/ },
  {
    name: "hardcoded-localhost",
    re: /localhost|127\.0\.0\.1/,
    contentOnly: true,
    skipTest: true,
  },
];

function usage() {
  process.stderr.write(
    "usage: node scripts/check-public-portability.mjs <git-diff-range>\n" +
      "   e.g. node scripts/check-public-portability.mjs origin/master...HEAD\n",
  );
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function isTestPath(p) {
  return (
    /(^|\/)(tests?|__tests__)(\/|$)/i.test(p) ||
    /\.(test|spec)\./i.test(p) ||
    /(^|\/)test_[^/]*$/i.test(p) ||
    /_test\.[a-z0-9]+$/i.test(p)
  );
}

function isSelf(p) {
  return p.split("/").pop() === SELF_BASENAME;
}

function isGeneratedMigrationMetadata(p) {
  return /^packages\/db\/src\/migrations\/meta\/\d+_snapshot\.json$/.test(p);
}

function isGeneratedSnapshotIdentity(file, line, text) {
  return (
    isGeneratedMigrationMetadata(file) &&
    (line === 2 || line === 3) &&
    /^\s*"(?:id|prevId)":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"[,]?\s*$/i.test(text)
  );
}

function stripPublicPackageSpecifiers(text) {
  // Only module specifiers are exempt. Do not skip the rest of the line:
  // another prohibited marker alongside an import must still be reported.
  return text.replace(
    /((?:\b(?:from|import|export)\s*|\brequire\s*\()?["'])@paperclipai\/[A-Za-z0-9@._/-]+(["'])/g,
    "$1$2",
  );
}

// A nested lockfile is any supported package-manager lockfile that is NOT the
// repo-root one. Public deltas must not carry an independently installable
// nested dependency tree.
function isNestedLockfile(p) {
  return (
    /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/.test(p) &&
    p !== "pnpm-lock.yaml"
  );
}

// Parse `git diff <range>` into a list of added lines, each tagged with the
// file path it was added to and the new-file line number.
function collectAddedLines(range) {
  const diff = git(["diff", range]);
  const added = [];
  let file = null;
  let newLineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      // "+++ b/path/to/file" or "+++ /dev/null"
      const rest = raw.slice(4);
      file = rest === "/dev/null" ? null : rest.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLineNo = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      if (file) added.push({ file, line: newLineNo, text: raw.slice(1) });
      newLineNo += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      // removed line: does not advance the new-file counter
      continue;
    }
    if (raw.startsWith(" ")) {
      newLineNo += 1;
      continue;
    }
    // "\ No newline at end of file" and other metadata: ignore.
  }
  return added;
}

function collectChangedPaths(range) {
  // Deleted paths are not public content. In particular, removing a nested
  // lockfile must not fail the gate merely because name-status reports it.
  const out = git(["diff", "--diff-filter=ACMR", "--name-only", range]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function collectViolations(added, paths) {
  const violations = [];

  // 1) Added content markers.
  for (const { file, line, text } of added) {
    if (isSelf(file)) continue;
    // Fixture strings in portability tests intentionally model prohibited
    // values; they are inputs to this checker, not public artifacts.
    if (isTestPath(file)) continue;
    for (const marker of CONTENT_MARKERS) {
      if (marker.name === "bare-uuid" && isGeneratedSnapshotIdentity(file, line, text)) continue;
      const scannedText = marker.name === "internal-host-or-url" ? stripPublicPackageSpecifiers(text) : text;
      const m = marker.re.exec(scannedText);
      if (m) {
        violations.push({
          file,
          line: String(line),
          marker: marker.name,
          match: m[0],
          where: "added-content",
        });
      }
    }
  }

  // 2) Changed path markers (path-level).
  for (const p of paths) {
    if (isSelf(p)) continue;
    for (const marker of CONTENT_MARKERS) {
      if (marker.contentOnly) continue;
      const m = marker.re.exec(p);
      if (m) {
        violations.push({
          file: p,
          line: "-",
          marker: marker.name,
          match: m[0],
          where: "path",
        });
      }
    }
    if (isNestedLockfile(p)) {
      violations.push({
        file: p,
        line: "-",
        marker: "nested-lockfile",
        match: p,
        where: "path",
      });
    }
  }

  return violations;
}

function main() {
  const range = process.argv[2];
  if (!range) {
    usage();
    process.exit(2);
  }

  let added;
  let paths;
  try {
    added = collectAddedLines(range);
    paths = collectChangedPaths(range);
  } catch (err) {
    process.stderr.write(`error: failed to run git diff for range "${range}":\n${err.message}\n`);
    process.exit(1);
  }

  const violations = collectViolations(added, paths);
  if (violations.length > 0) {
    process.stderr.write(
      `FAIL: check-public-portability found ${violations.length} prohibited marker(s) in range "${range}":\n`,
    );
    for (const v of violations) {
      process.stderr.write(
        `  [${v.marker}] ${v.file}:${v.line} (${v.where}) -> ${JSON.stringify(v.match)}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(`OK: no prohibited portability markers in range "${range}"\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
