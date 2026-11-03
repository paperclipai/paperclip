import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { canaryCandidates, selectCanarySource } from "./select-canary-source.mjs";
import { SourceVerificationFailed } from "./cloud-source-verification.mjs";

const sha = character => character.repeat(40);
const candidate = (character, published = false) => ({ sha: sha(character), published });
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const job = name => release.split(`  ${name}:\n`)[1].split(/\n  [a-z_]+:\n/)[0];

test("selects the newest verified source without waiting for unverified master tips", async () => {
  const checked = [];
  const result = await selectCanarySource([candidate("a"), candidate("b"), candidate("c")], async source => {
    checked.push(source);
    return source === sha("b") ? { sha: source } : undefined;
  });
  assert.equal(result, sha("b"));
  assert.deepEqual(checked, [sha("a"), sha("b")]);
});

test("skips failed source checks but propagates rate limits, API errors and invalid proof", async () => {
  assert.equal(await selectCanarySource([candidate("a"), candidate("b")], async source => {
    if (source === sha("a")) throw new SourceVerificationFailed("Failed checks");
    return { sha: source };
  }), sha("b"));
  for (const message of ["HTTP 403", "HTTP 429", "Malformed listing", "Ambiguous proof"]) {
    await assert.rejects(selectCanarySource([candidate("a"), candidate("b")], async () => {
      throw new Error(message);
    }), new RegExp(message));
  }
  await assert.rejects(selectCanarySource([candidate("a")], async () => ({ sha: sha("b") })));
});

test("unchanged sources and older candidates never republish or roll the channel backward", async () => {
  const checked = [];
  assert.equal(await selectCanarySource([candidate("a"), candidate("b", true), candidate("c")], async source => {
    checked.push(source);
    return undefined;
  }), undefined);
  assert.deepEqual(checked, [sha("a")]);
  assert.equal(await selectCanarySource([candidate("a", true)], () => assert.fail("Published source must skip")), undefined);
  assert.equal(await selectCanarySource([], () => assert.fail("Empty history must skip")), undefined);
});

test("selection limits API work to twenty candidates per tick", async () => {
  let reads = 0;
  const candidates = Array.from({ length: 30 }, () => candidate("a"));
  assert.equal(await selectCanarySource(candidates, async () => { reads++; }), undefined);
  assert.equal(reads, 20);
});

test("candidate discovery follows first-parent master history and peels annotated canary tags", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "hourly-canary-git-"));
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(["init", "--initial-branch=master"]);
    git(["config", "user.name", "Release fixture"]);
    git(["config", "user.email", "release-fixture@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    writeFileSync(path.join(cwd, "source.txt"), "first");
    git(["add", "."]);
    git(["commit", "-m", "First"]);
    const first = git(["rev-parse", "HEAD"]).trim();
    git(["tag", "-a", "canary/v2026.101.0-canary.0", "-m", "Published"]);
    writeFileSync(path.join(cwd, "source.txt"), "second");
    git(["commit", "-am", "Second"]);
    const second = git(["rev-parse", "HEAD"]).trim();
    git(["tag", "nightly/v2026.101.0-nightly.0"]);
    assert.deepEqual(canaryCandidates(second, git), [{ sha: second, published: false }, { sha: first, published: true }]);
    assert.throws(() => canaryCandidates("master", () => assert.fail("Mutable refs must not reach git")));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("only hourly and manual canaries enter selection; nightlies keep a separate lane", () => {
  assert.doesNotMatch(release.split("concurrency:\n")[0], /^  push:/m);
  const condition = job("select_canary").match(/^    if: (.+)$/m)[1];
  for (const [event, schedule, channel, ref, repository, expected] of [
    ["schedule", "17 * * * *", "", "refs/heads/master", "paperclipai/paperclip", true],
    ["schedule", "0 9 * * *", "", "refs/heads/master", "paperclipai/paperclip", false],
    ["push", "", "", "refs/heads/master", "paperclipai/paperclip", false],
    ["workflow_dispatch", "", "canary", "refs/heads/master", "paperclipai/paperclip", true],
    ["workflow_dispatch", "", "nightly", "refs/heads/master", "paperclipai/paperclip", false],
    ["workflow_dispatch", "", "cloud-migrator", "refs/heads/master", "paperclipai/paperclip", false],
    ["workflow_dispatch", "", "canary", "refs/heads/topic", "paperclipai/paperclip", false],
    ["schedule", "17 * * * *", "", "refs/heads/master", "fork/paperclip", false],
  ]) {
    assert.equal(runInNewContext(condition, { github: { repository, repository_id: "1170821064", ref,
      event_name: event, event: { schedule } }, inputs: { channel } }), expected);
  }
  const concurrency = release.match(/^  group: \$\{\{ (.+) \}\}$/m)[1];
  const group = (event, schedule, channel) => runInNewContext(concurrency, {
    github: { event_name: event, event: { schedule }, ref: "refs/heads/master" },
    inputs: { channel, source_ref: "master" },
    format: (pattern, ...values) => pattern.replace(/\{(\d+)\}/g, (_, index) => values[index]),
  });
  assert.equal(group("schedule", "17 * * * *", ""), group("workflow_dispatch", "", "canary"));
  assert.notEqual(group("schedule", "17 * * * *", ""), group("schedule", "0 9 * * *", ""));
  assert.match(job("select_nightly"), /event.schedule == '0 9 \* \* \*'/);
});

test("the immutable selection reaches verification, binaries, publication and the smoke lockfile", () => {
  assert.match(job("verify_canary"), /SOURCE_SHA: \$\{\{ needs.select_canary.outputs.sha \}\}/);
  assert.match(job("release_runner_source"), /needs: \[select_canary, verify_canary, select_nightly, select_beta, preflight_stable\]/);
  assert.match(job("release_runner_source"), /needs.select_nightly.outputs.sha \|\| needs.select_canary.outputs.sha/);
  assert.match(job("release_runner_binaries"), /ref: \$\{\{ needs.release_runner_source.outputs.sha \}\}/);
  for (const property of ["ref", "SOURCE_SHA"]) {
    assert.match(job("publish_canary"), new RegExp(`${property}: \\$\\{\\{ needs.select_canary.outputs.sha \\}\\}`));
  }
  assert.doesNotMatch(job("publish_canary"), /github.sha/);
  assert.match(job("smoke_canary_onboarding"), /ref: \$\{\{ needs.publish_canary.outputs.source_sha \}\}/);
  assert.match(job("smoke_canary_onboarding"), /name: canary-smoke-lockfile-\$\{\{ needs.publish_canary.outputs.source_sha \}\}/);
  assert.match(job("publish_canary"), /--skip-verify \$\{\{ inputs.dry_run && '--dry-run' \|\| '' \}\}/);
  assert.match(job("publish_canary"), /name: Push canary tag\n\s+if: \$\{\{ !inputs.dry_run \}\}/);
});

test("Cloud verification, master images and exact-source migrators retain their independent triggers", () => {
  for (const name of ["cloud-readiness.yml", "docker.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.match(workflow, /^  push:/m);
    assert.match(workflow, /master/);
  }
  assert.match(job("plan_preview"), /inputs.channel == 'preview' \|\| inputs.channel == 'cloud-migrator'/);
  assert.match(job("plan_preview"), /SOURCE_SHA: \$\{\{ inputs.source_ref \}\}/);
  assert.doesNotMatch(job("plan_preview"), /needs:.*canary/);
  assert.match(job("publish_preview"), /environment: npm-canary/);
});

test("native source selection still admits each promotion lane when canary jobs are skipped", () => {
  const condition = job("release_runner_source").match(/if: >-\n([\s\S]*?)\n    runs-on:/)[1].trim();
  for (const active of ["canary", "nightly", "beta", "stable"]) {
    const needs = {
      select_canary: { outputs: { proceed: active === "canary" ? "true" : "" } },
      verify_canary: { result: active === "canary" ? "success" : "skipped" },
      select_nightly: { result: active === "nightly" ? "success" : "skipped", outputs: { proceed: "true" } },
      select_beta: { result: active === "beta" ? "success" : "skipped" },
      preflight_stable: { result: active === "stable" ? "success" : "skipped" },
    };
    assert.equal(runInNewContext(condition, { needs, cancelled: () => false }), true, active);
    assert.equal(runInNewContext(condition, { needs, cancelled: () => true }), false, active);
  }
});

test("a dry-run publisher with no published version cannot launch onboarding", () => {
  const condition = job("smoke_canary_onboarding").match(/^    if: \$\{\{ (.+) \}\}$/m)[1];
  for (const version of ["", "2026.101.0-canary.0"]) {
    assert.equal(runInNewContext(condition, { cancelled: () => false, needs: {
      publish_canary: { result: "success", outputs: { canary_version: version } },
    } }), Boolean(version));
  }
});
