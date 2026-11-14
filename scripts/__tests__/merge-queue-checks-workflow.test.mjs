import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflows = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const workflow = readFileSync(path.join(workflows, "merge-queue-checks.yml"), "utf8");
const jobNames = [...workflow.matchAll(/^    name: (.+)$/gm)].map(match => match[1]);

test("the merge queue reports the check names that pull requests report", () => {
  const caller = readFileSync(path.join(workflows, "pr.yml"), "utf8");
  const trusted = readFileSync(path.join(workflows, "pr-trusted.yml"), "utf8");
  assert.match(caller, /^  ci:\n(?: {4}.*\n)*? {4}uses: .+\/pr-trusted\.yml@/m, "pr.yml reports its checks under the ci job");
  for (const job of ["verify", "e2e"]) {
    assert.match(trusted, new RegExp(`^  ${job}:\\n    name: ${job}$`, "m"), `pull requests report ci / ${job}`);
  }
  assert.deepEqual(jobNames, ["ci / verify", "ci / e2e"]);
});

test("the merge queue checks cannot read the queued commit or any credential", () => {
  const triggers = workflow.split("\non:\n")[1].split("\n\n")[0];
  assert.equal(triggers.trim(), "merge_group:", "only the merge queue triggers these checks");
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /^ +permissions:/m, "no job widens the empty token");
  assert.doesNotMatch(workflow, /secrets\.|uses:|environment:|id-token|runs-on\//);
  assert.deepEqual([...workflow.matchAll(/^    runs-on: (.+)$/gm)].map(match => match[1]), ["ubuntu-latest", "ubuntu-latest"]);
});
