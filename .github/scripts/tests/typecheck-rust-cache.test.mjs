import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../workflows/release-verify.yml", import.meta.url), "utf8");
const typecheck = workflow.split("  typecheck:\n")[1].split("  general_tests:\n")[0];
const cache = typecheck.split("      - name: Cache typecheck Rust dependencies\n")[1].split("      - name: Validate release package manifest")[0];
const sha = "a".repeat(40);
const github = { repository: "paperclipai/paperclip", event_name: "push", ref: "refs/heads/master", sha };
for (const [name, overrides, ref, allowed] of [
  ["exact master push", {}, sha, true],
  ["PR", { event_name: "pull_request", ref: "refs/pull/1/merge" }, sha, false],
  ["privileged PR", { event_name: "pull_request_target" }, sha, false],
  ["fork", { repository: "someone/paperclip" }, sha, false],
  ["branch", { ref: "refs/heads/feature" }, sha, false],
  ["manual source", { event_name: "workflow_dispatch" }, sha, false],
  ["unmerged source", {}, "b".repeat(40), false],
  ["moving ref", {}, "master", false],
]) {
  test(`typecheck cache restore and save: ${name}`, () => {
    for (const field of ["if", "save-if"]) {
      const expr = cache.match(new RegExp(`^ +${field}: \\$\\{\\{ (.+) \\}\\}$`, "m"))?.[1];
      assert.ok(expr);
      assert.equal(runInNewContext(expr, { github: { ...github, ...overrides }, inputs: { ref } }), allowed);
    }
  });
}
test("cache excludes workspace code and executable installs, and preserves full checks", () => {
  assert.match(cache, /uses: Swatinem\/rust-cache@[a-f0-9]{40}/);
  // The target path feeds the entry's version hash; a checkout-relative path
  // hashes differently on the fleet (/home/runner/_work) and on GitHub-hosted
  // runners (/home/runner/work), so the pin step publishes a $HOME-anchored one.
  assert.match(cache, /workspaces: \$\{\{ steps\.runner_rust_workspace\.outputs\.path \}\} -> target/);
  assert.match(cache, /shared-key: release-typecheck-v2/);
  assert.match(cache, /cache-workspace-crates: false/);
  assert.match(cache, /cache-bin: false/);
  const pin = typecheck.indexOf("      - name: Pin the Runner Rust workspace path");
  assert.ok(pin >= 0 && pin < typecheck.indexOf("uses: Swatinem/rust-cache"));
  assert.ok(typecheck.indexOf('echo "RUSTUP_TOOLCHAIN=$toolchain"') < typecheck.indexOf("uses: Swatinem/rust-cache"));
  assert.doesNotMatch(typecheck, /workspaces: (\.|packages\/|\$\{\{ github\.workspace)/);
});
// The typecheck key is written and read only by master pushes on the fleet, so
// its version would still match if this pin drifted. Hold it to the same text
// as the Runner writer anyway: `doc/RELEASE-AUTOMATION-SETUP.md` promises one
// identical pin step before every Rust cache step, and a divergent copy here
// is the first place a later edit would quietly break that promise.
test("the typecheck pin step is identical to the Runner writer's", () => {
  const PIN = /# rust-cache hashes its absolute cache paths[\s\S]*?echo "path=\$pinned" >> "\$GITHUB_OUTPUT"\n/;
  const writer = workflow.split("\n  verify_paperclip_runner:\n")[1];
  assert.ok(writer, "release-verify.yml is missing the verify_paperclip_runner job");
  const theirs = writer.match(PIN);
  const mine = typecheck.match(PIN);
  assert.ok(theirs, "the Runner writer must pin the Runner Rust workspace path");
  assert.ok(mine, "the typecheck job must pin the Runner Rust workspace path");
  assert.equal(mine[0], theirs[0], "the typecheck pin step drifted from the Runner writer's");
  assert.match(typecheck, /run: pnpm -r typecheck/);
  assert.match(workflow, /shared-key: release-runner-v2/);
});
