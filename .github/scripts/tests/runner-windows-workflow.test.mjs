import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/runner-windows.yml", import.meta.url), "utf8");

function pathFilter(event) {
  const block = workflow.split(`\n  ${event}:\n`)[1]?.split(/\n  \S/)[0];
  assert.ok(block, `${event} trigger is missing`);
  return [...block.matchAll(/^\s+- (\S+)$/gm)].map(match => match[1]);
}

test("the Windows Runner lane runs on pull requests and master for every Runner input", () => {
  const pullRequest = pathFilter("pull_request");
  const push = pathFilter("push");
  assert.deepEqual(push, pullRequest);
  assert.match(workflow, /push:\s*\n\s*branches: \[master\]/);
  for (const path of [
    ".github/workflows/runner-windows.yml",
    "packages/paperclip-runner/rust-toolchain.toml",
    "packages/paperclip-runner/runner/**",
    "packages/paperclip-runner/protocol/**",
  ]) assert.ok(pullRequest.includes(path), `missing path filter ${path}`);
});

test("the Windows Runner lane builds and tests the locked workspace on hosted Windows x64", () => {
  assert.match(workflow, /runs-on: windows-2025\n/);
  assert.match(workflow, /shell: bash\n/);
  assert.match(workflow, /run: \|\n\s+rustup toolchain install\n/);
  assert.match(workflow, /run: >-\n\s+cargo test --release --manifest-path runner\/Cargo.toml --locked --workspace --no-fail-fast --\n\s+--exact --skip /);
  assert.doesNotMatch(workflow, /continue-on-error|if: always\(/);
});

test("the Windows Runner lane skips only exact named tests", () => {
  const skipped = [...workflow.matchAll(/--skip (\S+)/g)].map(match => match[1]);
  assert.deepEqual(skipped, ["acpx_provider_backend::tests::binds_sidecar_paths_arguments_and_contents_to_the_runner_profile"]);
  assert.match(workflow, /--exact --skip /);
});

test("the Windows Runner lane is read-only and keeps its own master-written cache", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(workflow, /: write\b|secrets\.|pull_request_target/);
  assert.match(workflow, /persist-credentials: false/);
  for (const [, ref] of workflow.matchAll(/uses: \S+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  assert.match(workflow, /shared-key: runner-windows-v1\n/);
  assert.match(workflow, /save-if: \$\{\{ github.event_name == 'push' \}\}\n/);
});
