import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../../workflows/${name}`, import.meta.url), "utf8");
const prWorkflow = read("pr-trusted.yml");
const releaseWorkflow = read("release-verify.yml");

// Slice one job out of a workflow: from its two-space-indented key to the
// next one. Steps sit at six spaces and `with:` at eight, so only job keys
// match the boundary pattern.
const job = (workflow, name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `workflow is missing the ${name} job`);
  const body = workflow.slice(start + 1);
  const header = `  ${name}:\n`.length;
  const next = body.slice(header).search(/\n  [a-z0-9_-]+:\n/);
  return next === -1 ? body : body.slice(0, header + next + 1);
};

const READ_STEP = "      - name: Restore Runner Rust dependencies (read only)";
const WRITE_STEP = "      - name: Cache Runner Rust dependencies";
const SELECT_STEP = "      - name: Select the pinned Runner Rust toolchain";

// Every PR job that builds the Runner restores master's `release-runner-v2`
// entry. Each one has to agree with the writer on every key input, or that
// one lane misses and silently recompiles every third-party crate while the
// others hit.
const READER_JOBS = ["typecheck_release_registry", "verify_paperclip_runner", "build", "canary_dry_run"];
const readers = READER_JOBS.map((name) => [name, job(prWorkflow, name)]);
const release = job(releaseWorkflow, "verify_paperclip_runner");

test("every rust-cache restore in the PR workflow belongs to a guarded reader job", () => {
  const total = prWorkflow.match(/uses: Swatinem\/rust-cache@/g)?.length ?? 0;
  const guarded = readers.filter(([, body]) => /uses: Swatinem\/rust-cache@/.test(body)).length;
  assert.equal(guarded, READER_JOBS.length, "each listed reader job must restore the Rust cache");
  assert.equal(total, guarded, "a job restores the Rust cache but is not in READER_JOBS; add it so it is guarded");
  for (const [name, body] of readers) {
    assert.equal(body.match(/uses: Swatinem\/rust-cache@/g).length, 1, `${name}: exactly one rust-cache step`);
    assert.ok(body.includes(READ_STEP), `${name}: the rust-cache step must be the read-only restore`);
  }
});

// The key is computed from these inputs. A pull request that disagrees with
// the master writer on any of them misses every time and silently recompiles
// all 313 third-party crates in both profiles, which is exactly the cost this
// restore exists to remove.
const keyInputs = [
  /uses: Swatinem\/rust-cache@([0-9a-f]{40}) # v[0-9.]+/,
  /workspaces: (\$\{\{ steps\.runner_rust_workspace\.outputs\.path \}\} -> target)/,
  /shared-key: (release-runner-v2)/,
  /cache-workspace-crates: (false)/,
  /cache-bin: (false)/,
];

test("every PR reader restores the Rust cache under the same key the master push writes", () => {
  for (const [name, pr] of readers) {
    for (const pattern of keyInputs) {
      const mine = pr.match(pattern);
      const theirs = release.match(pattern);
      assert.ok(mine, `${name}: PR lane is missing ${pattern}`);
      assert.ok(theirs, `master writer is missing ${pattern}`);
      assert.equal(mine[1], theirs[1], `${name}: key input drifted from the master writer: ${pattern}`);
    }
    assert.doesNotMatch(pr, /prefix-key:|cache-on-failure: true|cache-all-crates: true/, name);
  }
});

test("every PR reader pins the compiler before the key is computed", () => {
  for (const [name, pr] of readers) {
    const select = pr.indexOf(SELECT_STEP);
    const cache = pr.indexOf(READ_STEP);
    assert.ok(select >= 0 && cache > select, `${name}: the toolchain must be selected before the cache step`);
    const setup = pr.slice(select, cache);
    // Nothing may sit between the pin and the restore that could change the key.
    assert.equal(setup.match(/^      - name: /gm).length, 1, `${name}: no step between the toolchain pin and the restore`);
    assert.match(setup, /working-directory: packages\/paperclip-runner/, name);
    assert.match(setup, /rustup show active-toolchain/, name);
    assert.match(setup, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/, name);
    // The gate routes to either ubuntu-latest or the public PR fleet, so a
    // missing rustup must cost the cache, never the pull request.
    assert.match(setup, /command -v rustup/, name);
    assert.doesNotMatch(setup, /set -euo pipefail/, name);
  }
});

test("a pull request never writes to or evicts the master cache entry", () => {
  for (const [name, pr] of readers) {
    const after = pr.split(READ_STEP)[1];
    const nextStep = after.search(/\n      - name: /);
    const step = nextStep === -1 ? after : after.slice(0, nextStep);
    assert.equal(step.match(/^\s*save-if: (.+)$/m)?.[1], "false", `${name}: the restore must set save-if: false`);
    assert.doesNotMatch(step, /^\s*if:/m, `${name}: the restore must not be conditional; a miss is already free`);
  }
  assert.doesNotMatch(prWorkflow, /uses: Swatinem\/rust-cache@[0-9a-f]{40}[\s\S]*?save-if: (?!false)/);
});

// The cache key mixes in every toolchain rust-cache can find, so the runner
// image's own stable Rust lands in it too. The fleets carried 1.98.0 while
// ubuntu-latest carried 1.98.1, which is why GitHub-hosted pull requests
// missed a cache the fleet hit. Both workflows now strip everything but the
// pin. They have to do it the same way: if the reader and the writer disagree,
// the key matches nothing and every run recompiles.
const NORMALIZE = /# rust-cache hashes every installed toolchain[\s\S]*?rustup toolchain list\n/;

test("every reader and the writer strip extra toolchains identically before the key is computed", () => {
  const theirs = release.match(NORMALIZE);
  assert.ok(theirs, "release-verify.yml must normalize the installed toolchains");
  for (const [name, body] of [["writer", theirs[0]]]) {
    // Keep the pin, drop the rest, and never fail the job over it.
    assert.match(body, /grep -vx "\$toolchain"/, name);
    assert.match(body, /xargs -n1 rustup toolchain uninstall/, name);
    assert.match(body, /\|\| true/, name);
  }
  for (const [name, pr] of readers) {
    const mine = pr.match(NORMALIZE);
    assert.ok(mine, `${name}: pr-trusted.yml must normalize the installed toolchains`);
    assert.equal(mine[0], theirs[0], `${name}: the normalization must be identical to the writer's`);
  }
});

test("the toolchain is stripped before the cache step, not after", () => {
  for (const [name, body, cacheStep] of [
    ...readers.map(([name, body]) => [name, body, READ_STEP]),
    ["writer", release, WRITE_STEP],
  ]) {
    const normalize = body.search(NORMALIZE);
    const cache = body.indexOf(cacheStep);
    assert.ok(normalize >= 0 && cache > normalize, `${name}: normalization must precede the cache step`);
  }
});

// GitHub matches a cache entry on its key and on a version hash of the
// absolute paths being cached. rust-cache resolves the target directory under
// the checkout, and the checkout root differs by runner (/home/runner/_work on
// the RunsOn fleets that write the cache, /home/runner/work on GitHub-hosted
// runners). With every key input aligned, every GitHub-hosted pull request
// still logged "No cache found" (run 36424309181, 2026-09-28). Both workflows
// therefore hand rust-cache the same checkout-independent path, and they have
// to build it the same way or the version matches nothing.
const PIN = /# rust-cache hashes its absolute cache paths[\s\S]*?echo "path=\$pinned" >> "\$GITHUB_OUTPUT"\n/;

test("every reader and the writer pin an identical checkout-independent Rust workspace path", () => {
  const theirs = release.match(PIN);
  assert.ok(theirs, "release-verify.yml must pin the Runner Rust workspace path");
  const pins = [["writer", theirs[0]]];
  for (const [name, pr] of readers) {
    const mine = pr.match(PIN);
    assert.ok(mine, `${name}: pr-trusted.yml must pin the Runner Rust workspace path`);
    assert.equal(mine[0], theirs[0], `${name}: the pinned path must be built identically to the writer's`);
    pins.push([name, mine[0]]);
  }

  for (const [name, body] of pins) {
    assert.match(body, /- name: Pin the Runner Rust workspace path\n\s+id: runner_rust_workspace\n/, name);
    // Anchor under $HOME, which both runner images share, never under the checkout.
    assert.match(body, /pinned="\$HOME\/[A-Za-z0-9._-]+"/, name);
    assert.match(body, /rm -rf "\$pinned"\n\s+ln -s "\$GITHUB_WORKSPACE\/packages\/paperclip-runner\/runner" "\$pinned"/, name);
    assert.match(body, /echo "path=\$pinned" >> "\$GITHUB_OUTPUT"/, name);
  }
});

test("the workspace path is pinned before the cache step and never names the checkout", () => {
  for (const [name, body, cacheStep] of [
    ...readers.map(([name, body]) => [name, body, READ_STEP]),
    ["writer", release, WRITE_STEP],
  ]) {
    const pin = body.search(PIN);
    const cache = body.indexOf(cacheStep);
    assert.ok(pin >= 0 && cache > pin, `${name}: the pin must precede the cache step`);
    assert.doesNotMatch(body, /workspaces: (\.|packages\/|\$\{\{ github\.workspace)/, `${name}: workspaces must not resolve under the checkout`);
  }
  // No rust-cache step anywhere in either workflow may point back into the checkout.
  for (const [name, workflow] of [["pr-trusted.yml", prWorkflow], ["release-verify.yml", releaseWorkflow]]) {
    assert.doesNotMatch(workflow, /workspaces: (\.|packages\/|\$\{\{ github\.workspace)/, `${name}: workspaces must not resolve under the checkout`);
  }
});
