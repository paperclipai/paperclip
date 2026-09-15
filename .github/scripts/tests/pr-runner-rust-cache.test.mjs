import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../../workflows/${name}`, import.meta.url), "utf8");
const prWorkflow = read("pr-trusted.yml");
const releaseWorkflow = read("release-verify.yml");
const pr = prWorkflow.split("  verify_paperclip_runner:")[1].split("  build:")[0];
const release = releaseWorkflow.split("  verify_paperclip_runner:")[1].split("  build:")[0];

// The key is computed from these inputs. A pull request that disagrees with
// the master writer on any of them misses every time and silently recompiles
// all 313 third-party crates in both profiles, which is exactly the cost this
// restore exists to remove.
const keyInputs = [
  /uses: Swatinem\/rust-cache@([0-9a-f]{40}) # v[0-9.]+/,
  /workspaces: (packages\/paperclip-runner\/runner -> target)/,
  /shared-key: (release-runner-v1)/,
  /cache-workspace-crates: (false)/,
  /cache-bin: (false)/,
];

test("the PR lane restores the Rust cache under the same key the master push writes", () => {
  for (const pattern of keyInputs) {
    const mine = pr.match(pattern);
    const theirs = release.match(pattern);
    assert.ok(mine, `PR lane is missing ${pattern}`);
    assert.ok(theirs, `master writer is missing ${pattern}`);
    assert.equal(mine[1], theirs[1], `key input drifted from the master writer: ${pattern}`);
  }
  assert.doesNotMatch(pr, /prefix-key:|cache-on-failure: true|cache-all-crates: true/);
});

test("the PR lane pins the compiler before the key is computed", () => {
  const select = pr.indexOf("      - name: Select the pinned Runner Rust toolchain");
  const cache = pr.indexOf("      - name: Restore Runner Rust dependencies (read only)");
  const verify = pr.indexOf("      - name: Verify Paperclip Runner\n");
  assert.ok(select >= 0 && cache > select && verify > cache);
  const setup = pr.slice(select, cache);
  assert.match(setup, /working-directory: packages\/paperclip-runner/);
  assert.match(setup, /rustup show active-toolchain/);
  assert.match(setup, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/);
  // The gate routes to either ubuntu-latest or the public PR fleet, so a
  // missing rustup must cost the cache, never the pull request.
  assert.match(setup, /command -v rustup/);
  assert.doesNotMatch(setup, /set -euo pipefail/);
});

test("a pull request never writes to or evicts the master cache entry", () => {
  const step = pr.split("      - name: Restore Runner Rust dependencies (read only)")[1]
    .split("      - name: Verify Paperclip Runner\n")[0];
  assert.equal(step.match(/^\s*save-if: (.+)$/m)?.[1], "false");
  assert.doesNotMatch(step, /^\s*if:/m, "the restore must not be conditional; a miss is already free");
  assert.doesNotMatch(prWorkflow, /uses: Swatinem\/rust-cache@[0-9a-f]{40}[\s\S]*?save-if: (?!false)/);
});
