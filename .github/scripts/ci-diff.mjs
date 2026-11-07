import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Read trees only. The routing job fetches Git objects into a bare repository;
// no pull request code, hooks, filters or package scripts run here.
export function mergeDiff(merge, prHead, cwd = process.cwd()) {
  assert.match(merge ?? "", /^[a-f0-9]{40}$/);
  assert.match(prHead ?? "", /^[a-f0-9]{40}$/);
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).trim();
  const header = git("--no-replace-objects", "cat-file", "-p", merge).split("\n\n", 1)[0];
  const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map((match) => match[1]);
  assert.equal(parents.length, 2, "Expected a GitHub pull request merge commit");
  assert.equal(parents[1], prHead, "Merge commit does not contain the expected PR head");
  const base = parents[0];
  const changed = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--name-only", "-z", base, merge, "--"], {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).sort();
  return { diff: { source: "git-merge-parent", base, head: merge, prHead }, changed };
}
