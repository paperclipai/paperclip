// Deterministic process adapter, not a mocked task outcome. The worker must
// actually read the prepared repository and use its run-scoped task API.
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const env = process.env;
const headers = { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID, "Content-Type": "application/json" };
const api = async (route, method = "GET", body) => {
  const response = await fetch(`${env.PAPERCLIP_API_URL}/api${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
};
const run = await api(`/heartbeat-runs/${env.PAPERCLIP_RUN_ID}`);
const issueId = run.contextSnapshot.issueId;
const repositories = await readdir(path.join(process.cwd(), ".paperclip-repositories"));
const repo = path.join(process.cwd(), ".paperclip-repositories", repositories.find((name) => !name.includes(".clone-")));
assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "Existing uncommitted work\n");
await assert.rejects(access(path.join(repo, "private.secret")));
await writeFile(path.join(repo, "recovery-proof.txt"), "Workspace recovered; existing work preserved; private files excluded.\n", { flag: "wx" });
await api(`/issues/${issueId}`, "PATCH", { status: "done", comment: "Workspace recovered automatically. I read the preserved uncommitted work, verified private files were excluded, and wrote recovery-proof.txt exactly once." });
console.log("Workspace recovery verification complete.");
