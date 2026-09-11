import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/release-verify.yml", import.meta.url), "utf8");
const runner = workflow.split("  verify_paperclip_runner:")[1].split("  build:")[0];

test("Runner dependency caching selects the package's pinned compiler before computing its key", () => {
  const select = runner.indexOf("      - name: Select the pinned Runner Rust toolchain");
  const cache = runner.indexOf("      - name: Cache Runner Rust dependencies");
  assert.ok(select >= 0 && cache > select);
  const setup = runner.slice(select, cache);
  assert.match(setup, /working-directory: packages\/paperclip-runner/);
  assert.match(setup, /rustup show active-toolchain/);
  assert.match(setup, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/);
  assert.match(runner, /uses: Swatinem\/rust-cache@[0-9a-f]{40} # v[0-9.]+/);
  assert.match(runner, /workspaces: packages\/paperclip-runner\/runner -> target/);
  assert.match(runner, /shared-key: release-runner-v1/);
});

test("the shared cache excludes workspace artifacts and only restores or saves the exact master-push source", () => {
  assert.match(runner, /cache-workspace-crates: false/);
  assert.match(runner, /cache-bin: false/);
  const saveIf = runner.match(/^\s*save-if: (.+)$/m)?.[1];
  assert.equal(saveIf, "${{ github.repository == 'paperclipai/paperclip' && github.event_name == 'push' && github.ref == 'refs/heads/master' && inputs.ref == github.sha }}");
  const cacheStep = runner.split("      - name: Cache Runner Rust dependencies")[1].split("      - name: Install dependencies")[0];
  assert.equal(cacheStep.match(/^\s*if: (.+)$/m)?.[1], saveIf);
  assert.doesNotMatch(runner, /cache-on-failure: true|cache-all-crates: true/);
});

test("cache hits cannot bypass Runner verification", () => {
  const verify = runner.split("      - name: Verify Paperclip Runner")[1];
  assert.match(verify, /run: pnpm --filter @paperclipai\/paperclip-runner check:all/);
  assert.doesNotMatch(verify, /if:|continue-on-error:/);
  assert.ok(runner.indexOf("Cache Runner Rust dependencies") < runner.indexOf("      - name: Verify Paperclip Runner\n"));
  assert.doesNotMatch(runner, /id-token: write|packages: write|secrets: inherit/);
});
