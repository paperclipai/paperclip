import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/refresh-lockfile.yml"),
  "utf8"
);

test("lockfile refresh pushes and manages its PR with a workflow-triggering credential", () => {
  // A push made with the default GITHUB_TOKEN triggers no pull_request
  // workflows, so the lockfile PR's required checks never start and
  // auto-merge waits forever while master's frozen installs keep failing.
  // Every credential surface must prefer the bot PAT and fall back to the
  // default token.
  const coalesce = /\$\{\{ secrets\.LOCKFILE_BOT_TOKEN \|\| github\.token \}\}/g;
  const occurrences = workflow.match(coalesce) ?? [];
  assert.ok(
    occurrences.length >= 4,
    `expected the LOCKFILE_BOT_TOKEN fallback on checkout, PR upsert, auto-merge, and verification (found ${occurrences.length})`
  );
  assert.doesNotMatch(
    workflow,
    /GH_TOKEN: \$\{\{ github\.token \}\}/,
    "no credential surface may use the bare default token"
  );
});

test("a lockfile PR whose required checks never start fails the run loudly", () => {
  assert.match(workflow, /Verify required checks started on the lockfile PR/);
  assert.match(workflow, /check-runs/);
  assert.match(
    workflow,
    /::error::Lockfile PR has no required checks running/,
    "the stuck state must surface as a red run with recovery guidance"
  );
});

test("auto-merge remains enabled so a green refresh lands without a human", () => {
  assert.match(workflow, /gh pr merge --auto --squash --delete-branch/);
});
