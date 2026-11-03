import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url), "utf8");
const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
const step = (name) => {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  assert.ok(body, `the refresh workflow must have a "${name}" step`);
  return body;
};
const condition = (name) => step(name).match(/^        if: (.+)$/m)?.[1].trim();

test("the bot key is only reachable from the master-only lockfile-refresh environment", () => {
  assert.match(workflow, /^    environment: lockfile-refresh$/m);
  const keyUses = workflow.match(/secrets\.LOCKFILE_BOT_PRIVATE_KEY/g) ?? [];
  assert.equal(keyUses.length, 1, "only the token step may read the bot key");
  assert.match(step("Create lockfile bot token"), /private-key: \$\{\{ secrets\.LOCKFILE_BOT_PRIVATE_KEY \}\}/);
});

test("the bot token is minted only after resolution and the release-age gate", () => {
  const order = (name) => {
    const index = stepNames.indexOf(name);
    assert.notEqual(index, -1, `missing step "${name}"`);
    return index;
  };
  assert.ok(order("Refresh pnpm lockfile") < order("Check release age of added package versions"));
  assert.ok(order("Check release age of added package versions") < order("Create lockfile bot token"));
  assert.ok(order("Create lockfile bot token") < order("Merge lockfile PR"));
});

test("the gate runs only for an open PR, and the bot acts only when the gate passes", () => {
  assert.equal(condition("Check release age of added package versions"), "steps.upsert-pr.outputs.pr_url != ''");
  assert.equal(condition("Hold lockfile PR for review"), "steps.release-age.outputs.eligible == 'false'");
  assert.equal(condition("Create lockfile bot token"), "steps.release-age.outputs.eligible == 'true'");
  assert.equal(condition("Merge lockfile PR"), "steps.release-age.outputs.eligible == 'true'");
});

test("a held refresh keeps its versions through the next master run's artifact", () => {
  assert.ok(stepNames.indexOf("Reuse versions from a held refresh") < stepNames.indexOf("Refresh pnpm lockfile"));
  const reuse = step("Reuse versions from a held refresh");
  assert.match(reuse, /gh run list --workflow refresh-lockfile\.yml --branch master --status success/);
  assert.match(reuse, /gh run download "\$run_id" --name held-pnpm-lock/);
  assert.match(
    reuse,
    /if \[ "\$\(sha256sum < pnpm-lock\.yaml\)" != "\$\(cat "\$held\/source-lock\.sha256"\)" \]; then[\s\S]*?exit 0\n          fi\n          cp "\$held\/pnpm-lock\.yaml" pnpm-lock\.yaml/,
    "a held lock must only be reused while master still has the lock it was resolved from",
  );
  assert.doesNotMatch(reuse, /chore\/refresh-lockfile/, "the PR branch is writable by others and must not seed resolution");

  for (const name of ["Stage held lockfile", "Save held lockfile for the next refresh"]) {
    assert.equal(condition(name), "steps.release-age.outputs.eligible == 'false'");
  }
  const stage = step("Stage held lockfile");
  assert.match(stage, /cp pnpm-lock\.yaml "\$RUNNER_TEMP\/held-upload\/pnpm-lock\.yaml"/);
  assert.match(stage, /sha256sum < "\$RUNNER_TEMP\/base-pnpm-lock\.yaml" > "\$RUNNER_TEMP\/held-upload\/source-lock\.sha256"/);
  const save = step("Save held lockfile for the next refresh");
  assert.match(save, /name: held-pnpm-lock/);
  assert.match(save, /path: \$\{\{ runner\.temp \}\}\/held-upload\//);
});

test("the bot merges only the commit this job pushed", () => {
  assert.match(step("Create or update pull request"), /echo "head_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  const merge = step("Merge lockfile PR");
  assert.match(merge, /HEAD_SHA: \$\{\{ steps\.upsert-pr\.outputs\.head_sha \}\}/);
  assert.match(merge, /GH_TOKEN: \$\{\{ steps\.bot-token\.outputs\.token \}\}/);
  assert.match(merge, /gh pr merge "\$PR_URL" .*--match-head-commit "\$HEAD_SHA"/);
});
