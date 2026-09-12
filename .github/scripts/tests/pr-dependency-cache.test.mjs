import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
const jobs = [...workflow.matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|$(?![\s\S]))/gm)];
const installers = jobs.filter(([, , body]) => body.includes("run: pnpm install --frozen-lockfile"));

test("PR workflows restore dependency stores without creating branch copies", () => {
  assert.equal(installers.length, 7);
  assert.doesNotMatch(workflow, /^ +cache: pnpm$/m);
  assert.doesNotMatch(workflow, /uses: actions\/cache(?:@|\/save@)/);
  for (const [, job, body] of jobs) {
    for (const step of body.split("      - name:").filter((step) => step.includes("uses: actions/setup-node@"))) {
      assert.match(step, /package-manager-cache: false/, job);
    }
  }
  const policy = jobs.find(([, name]) => name === "policy")[2];
  assert.doesNotMatch(policy, /uses: actions\/cache|cache: pnpm/);
});

for (const [, job, body] of installers) {
  test(`${job}: reuse master keys before restoring the resolved PR lockfile`, () => {
    const locate = body.indexOf("      - name: Locate pnpm store");
    const restore = body.indexOf("      - name: Restore pnpm store (read only)");
    const artifact = body.indexOf("      - name: Restore regenerated PR lockfile");
    const install = body.indexOf("run: pnpm install --frozen-lockfile");
    assert.ok(locate >= 0 && locate < restore && restore < artifact && artifact < install);
    const cache = body.slice(restore, artifact);
    assert.match(body.slice(locate, restore), /pnpm store path --silent/);
    assert.match(body.slice(locate, restore), /node -p 'process.arch'/);
    assert.match(cache, /uses: actions\/cache\/restore@[a-f0-9]{40}/);
    assert.ok(cache.includes("key: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}"));
    assert.ok(cache.includes("restore-keys: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-"));
    assert.match(body.slice(artifact, install), /if: needs.policy.outputs.lockfile_regenerated == '1'/);
    assert.match(body.slice(artifact, install), /name: pr-lockfile/);
    assert.doesNotMatch(body.slice(artifact, install), /continue-on-error/);
  });
}
