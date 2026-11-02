// Real process adapter: verify Git and complete through the run-scoped API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const headers = { Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID, "Content-Type": "application/json" };
const api = async (route, method = "GET", body) => {
  const response = await fetch(`${process.env.PAPERCLIP_API_URL}/api${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
};
const run = await api(`/heartbeat-runs/${process.env.PAPERCLIP_RUN_ID}`);
assert.equal(run.contextSnapshot.paperclipWorkspace.mode, "isolated_workspace");
process.chdir(run.contextSnapshot.paperclipWorkspace.cwd);
assert.equal(await readFile("README.md", "utf8"), "Branch repair acceptance fixture\n");
if (process.argv.includes("--expect-setup")) {
  assert.equal(await readFile("setup-proof.txt", "utf8"), "ready");
  assert.match(git("branch", "--show-current"), /^agent\//);
  assert.match(process.cwd(), /\.agent-worktrees/);
}
assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "origin/master"));
await api(`/issues/${run.contextSnapshot.issueId}`, "PATCH", { status: "done", comment: `Branch repair verified: the agent started in an isolated worktree at master (${git("rev-parse", "HEAD")}).` });
console.log("Branch repair verified in the real Git worktree.");
