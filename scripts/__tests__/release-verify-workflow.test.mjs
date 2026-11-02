import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";
import { canaryStartup } from "./canary-startup-fixture.mjs";
import { canRetryPublishedTarball404, TARBALL_METADATA_TIMEOUT_MS } from "../../tests/canary-onboarding/start-published-canary.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("Docker Hub mirrors apply to both image builders without widening publication access", () => {
  const dockerWorkflow = readWorkflow("docker.yml");
  const releaseWorkflow = readWorkflow("release.yml");
  const docker = dockerWorkflow.split("  build-and-push:\n")[1].split("\n  merge-and-push:")[0];
  const preview = releaseWorkflow.split("  image_preview:\n")[1].split("\n  publish_image_preview:")[0];

  for (const job of [docker, preview]) {
    const steps = job.split(/\n(?=      - )/);
    const builder = steps.find((step) => /uses: docker\/setup-buildx-action@/.test(step));
    const build = steps.find((step) => /uses: docker\/build-push-action@/.test(step));
    assert.ok(builder && build, "the mirror must configure the builder that runs the image build");
    assert.ok(steps.indexOf(builder) < steps.indexOf(build));
    const config = builder.match(/buildkitd-config-inline: \|\n((?: {12,}[^\n]*(?:\n|$))+)/)?.[1];
    assert.ok(config, "configure the BuildKit container, not only the host Docker daemon");
    assert.deepEqual([...config.matchAll(/^\s*\[registry\."([^"]+)"\]/gm)].map((match) => match[1]), ["docker.io"],
      "GHCR publishing and cache traffic must not use the pull mirror");
    const mirrors = config.match(/^\s*mirrors = (\[[^\n]+\])$/m)?.[1];
    assert.ok(mirrors);
    assert.deepEqual(JSON.parse(mirrors), ["mirror.gcr.io"]);
    assert.doesNotMatch(config, /^\s*(?:http|insecure|ca|keypair)\s*=/m,
      "keep verified HTTPS and anonymous public-image pulls");
    assert.doesNotMatch(builder, /driver-opts:|buildkitd-flags:|secrets\./,
      "do not change bootstrap images, entitlements, or credentials");
  }

  assert.match(docker, /platform: linux\/amd64/);
  assert.match(docker, /platform: linux\/arm64/);
  assert.match(docker, /permissions:\n\s+contents: read\n\s+packages: write/);
  assert.match(docker, /outputs: type=image,name=ghcr\.io\/\$\{\{ github\.repository \}\},push-by-digest=true,name-canonical=true,push=true/);
  assert.match(docker, /cache-to: type=registry,ref=ghcr\.io\/\$\{\{ github\.repository \}\}:buildcache-\$\{\{ matrix\.arch \}\},mode=max/);
  assert.match(preview, /permissions:\n\s+contents: read\n\s+steps:/);
  assert.match(preview, /platforms: linux\/amd64\n\s+push: false/);
  assert.match(preview, /outputs: type=docker,dest=\$\{\{ runner\.temp \}\}\/preview-image\.tar/);
  assert.doesNotMatch(preview, /docker\/login-action|secrets\.|packages: write|id-token: write/);
  assert.match(releaseWorkflow, /publish_image_preview:\n[\s\S]*?needs: \[plan_preview, image_preview\]/);
  assert.doesNotMatch(dockerWorkflow.split("  merge-and-push:\n")[1], /buildkitd-config-inline/,
    "the registry-only manifest merge does not need a Docker Hub mirror");
});

test("chaos verification isolates callers that verify the same source commit", () => {
  const chaosWorkflow = readWorkflow("runner-chaos-evals.yml");
  const group = chaosWorkflow.match(/^  group: (.+)$/m)?.[1];
  assert.ok(group, "chaos verification must define its concurrency group");

  // GitHub supplies the top-level caller's workflow name to reusable calls.
  const resolveGroup = (caller, ref) => group
    .replaceAll("${{ github.workflow }}", readWorkflow(caller).match(/^name: (.+)$/m)[1])
    .replaceAll("${{ inputs.ref || github.ref }}", ref)
    .toLowerCase();
  const sha = "a".repeat(40);
  const callers = ["cloud-readiness.yml", "release.yml", "runner-chaos-evals.yml"];
  const groups = callers.map((caller) => resolveGroup(caller, sha));
  assert.equal(new Set(groups).size, callers.length,
    "Cloud readiness, Release, and standalone evals must not cancel each other");
  assert.ok(groups.every((value) => !value.includes("${{")), "resolve every group input");
  assert.notEqual(resolveGroup("cloud-readiness.yml", sha),
    resolveGroup("cloud-readiness.yml", "b".repeat(40)), "different sources remain independent");
  assert.match(chaosWorkflow, /cancel-in-progress: true/);
});

test("canary reuses exact-source proof while stable keeps full verification", () => {
  const releaseWorkflow = readWorkflow("release.yml");
  const canary = releaseWorkflow.match(/  verify_canary:\n[\s\S]*?(?=\n  [a-z_]+:)/)[0];
  assert.match(canary, /github\.repository == 'paperclipai\/paperclip' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);
  assert.match(canary, /actions: read/);
  assert.match(canary, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(canary, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(canary, /run: node scripts\/cloud-source-verification\.mjs "\$SOURCE_SHA"/);
  assert.doesNotMatch(canary, /release-verify\.yml|continue-on-error|always\(\)/);
  assert.match(releaseWorkflow, /publish_canary:\n\s+if: .*github\.event_name == 'push'.*\n\s+needs: \[verify_canary, release_runner_source, release_runner_binaries\]/);
  // The stable lane is gated on the stable channel since the nightly lane
  // was added; a `needs:` line (for example a preflight job) may sit between
  // the gate and the delegation.
  // The stable preflight resolves source_ref to an immutable SHA exactly
  // once; verification must consume that pin, not re-resolve the ref.
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.channel == 'stable'\n(?:\s+needs: [^\n]+\n)?\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.preflight_stable\.outputs\.sha \}\}/,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/,
  );
});

function canaryAttachmentScript() {
  const publish = readWorkflow("release.yml").split("  publish_canary:\n")[1].split("  smoke_canary_onboarding:\n")[0];
  const step = publish.split("      - name: Attach verified canary source to local master\n")[1]?.split("\n      - ")[0];
  assert.ok(step, "the trusted publisher must attach its pinned checkout before releasing");
  assert.match(step, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  const script = step.match(/run: \|\n((?: {10}[^\n]*\n)+)/)?.[1];
  assert.ok(script, "missing inline canary branch attachment shell");
  return script.replace(/^ {10}/gm, "");
}

function withCanaryGitFixture(check) {
  const root = mkdtempSync(path.join(os.tmpdir(), "canary-publisher-git-"));
  const cwd = path.join(root, "repository with spaces");
  mkdirSync(cwd);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=master");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "release-fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    writeFileSync(path.join(cwd, "source.txt"), "pinned source\n");
    git("add", "source.txt");
    git("commit", "-m", "Create pinned source");
    const pinned = git("rev-parse", "HEAD");
    writeFileSync(path.join(cwd, "source.txt"), "newer master source\n");
    git("commit", "-am", "Advance master");
    const newer = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/master", newer);
    git("checkout", "--detach", pinned);
    const env = {
      ...process.env, REPO_ROOT: cwd, SOURCE_SHA: pinned,
      GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "paperclipai/paperclip",
      GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master",
    };
    const attach = (overrides = {}) => spawnSync("bash", ["--noprofile", "--norc", "-c", canaryAttachmentScript()], {
      cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 5_000,
    });
    // Run the original release guard without running release.sh, npm, or a publisher.
    const guard = () => spawnSync("bash", ["-c", 'source "$1"; require_on_master_branch', "guard", path.join(repoRoot, "scripts/release-lib.sh")], {
      cwd, env, encoding: "utf8", timeout: 5_000,
    });
    check({ cwd, git, pinned, newer, attach, guard });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("canary publisher attaches the exact source while local and remote master are newer", () => {
  withCanaryGitFixture(({ cwd, git, pinned, newer, attach, guard }) => {
    assert.equal(guard().status, 1, "the unchanged release guard must reject detached HEAD even in Actions");
    assert.equal(git("rev-parse", "master"), newer);
    const result = attach();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("symbolic-ref", "--short", "HEAD"), "master");
    assert.equal(git("rev-parse", "HEAD"), pinned);
    assert.equal(git("rev-parse", "master"), pinned);
    assert.equal(git("rev-parse", "origin/master"), newer, "do not fetch or follow floating remote master");
    assert.equal(readFileSync(path.join(cwd, "source.txt"), "utf8"), "pinned source\n");
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(guard().status, 0, "the real release guard must accept the pinned local master");
  });
});

for (const [name, overrides] of [
  ["fork repository", { GITHUB_REPOSITORY: "example/paperclip" }],
  ["manual dispatch", { GITHUB_EVENT_NAME: "workflow_dispatch" }],
  ["scheduled release", { GITHUB_EVENT_NAME: "schedule" }],
  ["non-master push", { GITHUB_REF: "refs/heads/topic" }],
  ["tag push", { GITHUB_REF: "refs/tags/canary/v1" }],
  ["missing source SHA", { SOURCE_SHA: "" }],
  ["abbreviated source SHA", { SOURCE_SHA: "a".repeat(12) }],
  ["malformed source SHA", { SOURCE_SHA: "z".repeat(40) }],
]) {
  test(`canary publisher rejects ${name} before changing any Git reference`, () => {
    withCanaryGitFixture(({ git, pinned, attach, guard }) => {
      const refs = git("show-ref");
      const result = attach(overrides);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(git("show-ref"), refs);
      assert.equal(git("rev-parse", "HEAD"), pinned);
      assert.equal(guard().status, 1, "the rejected checkout must remain detached");
    });
  });
}

test("canary publisher rejects a different valid source SHA before changing Git references", () => {
  withCanaryGitFixture(({ git, pinned, newer, attach, guard }) => {
    const refs = git("show-ref");
    const result = attach({ SOURCE_SHA: newer });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(git("show-ref"), refs);
    assert.equal(git("rev-parse", "HEAD"), pinned);
    assert.equal(guard().status, 1);
  });
});

test("the original canary release guard still rejects a non-master local branch in Actions", () => {
  withCanaryGitFixture(({ git, pinned, guard }) => {
    git("checkout", "-b", "topic", pinned);
    const refs = git("show-ref");
    assert.equal(guard().status, 1);
    assert.equal(git("symbolic-ref", "--short", "HEAD"), "topic");
    assert.equal(git("show-ref"), refs);
  });
});

test("canary branch attachment keeps exact-source checkout and artifact order in its publishing lane", () => {
  const workflow = readWorkflow("release.yml");
  const publish = workflow.split("  publish_canary:\n")[1].split("  smoke_canary_onboarding:\n")[0];
  assert.equal(workflow.split("name: Attach verified canary source to local master").length, 2);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /name: canary-smoke-lockfile-\$\{\{ github\.sha \}\}/);
  const steps = ["Checkout repository", "Attach verified canary source to local master", "Install dependencies", "Save canary smoke lockfile", "Restore tracked install-time changes", "Publish canary"];
  for (let i = 1; i < steps.length; i++) {
    assert.ok(publish.indexOf(`name: ${steps[i - 1]}`) < publish.indexOf(`name: ${steps[i]}`));
  }
  assert.match(publish, /run: \.\/scripts\/release\.sh canary --skip-verify/);
  assert.doesNotMatch(canaryAttachmentScript(), /git fetch|git pull|checkout (?:master|origin\/master)(?:\s|$)/);
});

test("source proof requires every source check and does not wait on image publication", () => {
  const readiness = readWorkflow("cloud-readiness.yml");
  const proof = readiness.split("  source_verified:\n")[1];
  assert.match(proof, /name: Cloud source verified v1/);
  assert.match(proof, /needs: \[verify\]/);
  assert.match(proof, /node --test scripts\/cloud-source-verification.test.mjs/);
  assert.match(proof, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(proof, /always\(\)|continue-on-error|needs:.*(?:image|artifacts)/);
  assert.doesNotMatch(readiness, /^  (?:image|artifacts|ready):/m);
});

test("onboard smoke container binds beyond loopback so the mapped port is reachable", () => {
  const dockerfile = readFileSync(
    path.join(repoRoot, "docker/Dockerfile.onboard-smoke"),
    "utf8",
  );

  // `onboard --yes` without an explicit --bind prefers trusted-local
  // defaults and writes a loopback bind, which Docker port mapping cannot
  // reach. The smoke container must pin a non-loopback preset.
  assert.match(dockerfile, /onboard --yes --bind lan/);
});

test("promotion selection guards against sources that predate their channel tooling", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Promotions run the source commit's release.sh, so selection must reject
  // sources whose tooling does not know the target channel yet.
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly'/,
  );
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly\|beta\|stable\)'/,
  );
});

test("candidate-branch betas are validated and fully verified before publish", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Candidate heads are new commits: selection must pin the naming
  // convention and publication must be gated on full verification.
  assert.match(releaseWorkflow, /candidate\/beta-\*\)/);
  assert.match(
    releaseWorkflow,
    /verify_beta_candidate:\n\s+needs: select_beta\n\s+if: needs\.select_beta\.outputs\.mode == 'candidate'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml/,
  );
  assert.match(
    releaseWorkflow,
    /needs\.verify_beta_candidate\.result == 'success'/,
  );
});

test("post-publish beta smoke survives the skipped candidate-verification ancestor", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // publish_beta's needs chain contains verify_beta_candidate, which is
  // skipped on promote-mode betas. An `if:` without a status-check function
  // gets an implicit success() that evaluates that chain transitively and
  // silently skips the smoke. The condition must stay explicit.
  assert.match(
    releaseWorkflow,
    /smoke_beta:\n\s+needs: publish_beta\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish_beta\.result == 'success' && !inputs\.dry_run \}\}/,
  );
});

test("published canaries are gated by the exact-version onboarding browser smoke", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /publish_canary:[\s\S]*?outputs:\n\s+canary_version: \$\{\{ steps\.canary_tag\.outputs\.version \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:\n\s+needs: publish_canary\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish_canary\.result == 'success' \}\}/,
  );
  const smoke = releaseWorkflow.split("  smoke_canary_onboarding:\n")[1].split(/\n  [a-z_]+:\n/)[0];
  const condition = smoke.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.match(condition, /^!cancelled\(\) && needs\.publish_canary\.result == 'success'$/);
  for (const [result, cancelled, expected] of [
    ["success", false, true], ["failure", false, false],
    ["cancelled", false, false], ["skipped", false, false], ["success", true, false],
  ]) {
    const needs = { publish_canary: { result }, release_runner_source: { result: "success" },
      select_nightly: { result: "skipped" }, select_beta: { result: "skipped" }, preflight_stable: { result: "skipped" } };
    assert.equal(runInNewContext(condition, { cancelled: () => cancelled, needs }), expected,
      `Canary smoke: publisher=${result}, cancelled=${cancelled}`);
  }
  assert.match(
    releaseWorkflow,
    /PAPERCLIPAI_VERSION: \$\{\{ needs\.publish_canary\.outputs\.canary_version \}\}/,
  );
  assert.match(releaseWorkflow, /test:canary-onboarding-smoke/);
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/checkout@[0-9a-f]{40} # v7[\s\S]*?uses: pnpm\/action-setup@[0-9a-f]{40} # v6[\s\S]*?uses: actions\/setup-node@[0-9a-f]{40} # v7/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?Install test dependencies\n\s+run: pnpm install --frozen-lockfile/,
  );
  assert.doesNotMatch(
    releaseWorkflow.match(
      /smoke_canary_onboarding:[\s\S]*?(?=\n  # ----- Nightly lane)/,
    )?.[0] ?? "",
    /cache: pnpm/,
  );
  assert.match(
    releaseWorkflow,
    /name: Smoke exact published canary through onboarding\n\s+env:\n\s+PAPERCLIP_CANARY_SMOKE_SERVER_LOG: \$\{\{ runner\.temp \}\}\/canary-onboarding-server\.log/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/upload-artifact@[0-9a-f]{40} # v7/,
  );
  assert.match(releaseWorkflow, /canary-onboarding-server\.log/);
  assert.match(releaseWorkflow, /tests\/canary-onboarding\/playwright-report/);
});

test("canary smoke consumes its publisher's source-bound lockfile before frozen installation", () => {
  const workflow = readWorkflow("release.yml");
  const publish = workflow.split("  publish_canary:\n")[1].split("  smoke_canary_onboarding:\n")[0];
  const smoke = workflow.split("  smoke_canary_onboarding:\n")[1].split("  # ----- Nightly lane")[0];
  for (const job of [publish, smoke]) {
    assert.match(job, /name: Checkout repository\n\s+uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/);
    assert.match(job, /name: canary-smoke-lockfile-\$\{\{ github\.sha \}\}/);
    assert.match(job, /version: 9\.15\.4/);
  }
  assert.match(publish, /name: Save canary smoke lockfile\n\s+uses: actions\/upload-artifact@[0-9a-f]{40} # v4\n\s+with:\n\s+name: canary-smoke-lockfile-\$\{\{ github\.sha \}\}\n\s+path: pnpm-lock\.yaml\n\s+if-no-files-found: error\n\s+overwrite: true\n\s+retention-days: 14/);
  assert.ok(publish.indexOf("name: Install dependencies") < publish.indexOf("name: Save canary smoke lockfile"));
  assert.ok(publish.indexOf("name: Save canary smoke lockfile") < publish.indexOf("name: Restore tracked install-time changes"));
  assert.ok(publish.indexOf("name: Restore tracked install-time changes") < publish.indexOf("name: Publish canary"));
  assert.match(smoke, /name: Restore canary smoke lockfile\n\s+uses: actions\/download-artifact@[0-9a-f]{40} # v4\n\s+with:\n\s+name: canary-smoke-lockfile-\$\{\{ github\.sha \}\}/);
  assert.ok(smoke.indexOf("name: Restore canary smoke lockfile") < smoke.indexOf("name: Install test dependencies"));
  assert.doesNotMatch(smoke, /run-id:|github-token:|repository:|continue-on-error|--no-frozen-lockfile/);
});

for (const drift of ["patch", "manifest"]) {
  test(`a publisher lockfile lets a fresh smoke install retain validation after ${drift} drift`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "canary-smoke-lockfile-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "package");
    mkdirSync(source);
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "smoke-fixture-dependency", version: "1.0.0" }));
    writeFileSync(path.join(source, "index.js"), 'module.exports = "original";\n');
    const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: source, encoding: "utf8" });
    assert.equal(pack.status, 0, pack.stderr);
    const manifest = {
      name: "canary-smoke-fixture", private: true,
      packageManager: "pnpm@9.15.4",
      dependencies: { "smoke-fixture-dependency": "file:smoke-fixture-dependency-1.0.0.tgz" },
      pnpm: { patchedDependencies: { "smoke-fixture-dependency@1.0.0": "fixture.patch" } },
    };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const patch = (value) => writeFileSync(path.join(root, "fixture.patch"), [
      "diff --git a/index.js b/index.js", "index 1111111..2222222 100644",
      "--- a/index.js", "+++ b/index.js", "@@ -1 +1 @@",
      '-module.exports = "original";', `+module.exports = "${value}";`, "",
    ].join("\n"));
    const workflow = readWorkflow("release.yml");
    const publish = workflow.split("  publish_canary:\n")[1].split("  smoke_canary_onboarding:\n")[0];
    const smoke = workflow.split("  smoke_canary_onboarding:\n")[1].split("  # ----- Nightly lane")[0];
    const installArgs = (name) => {
      const job = name === "Install dependencies" ? publish : smoke;
      const command = job.match(new RegExp(`name: ${name}\\n\\s+run: (pnpm install[^\\n]+)`))?.[1];
      assert.ok(command, `missing ${name}`);
      return [...command.split(" ").slice(1), "--offline", "--ignore-scripts"];
    };
    const install = (args) => spawnSync("pnpm", args, {
      cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" },
    });
    const success = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    patch(drift === "patch" ? "old-patch" : "published-patch");
    success(install(installArgs("Install dependencies")));
    const staleLock = readFileSync(path.join(root, "pnpm-lock.yaml"));
    if (drift === "patch") {
      patch("published-patch");
    } else {
      copyFileSync(path.join(root, "smoke-fixture-dependency-1.0.0.tgz"), path.join(root, "updated-dependency.tgz"));
      manifest.dependencies["smoke-fixture-dependency"] = "file:updated-dependency.tgz";
      writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    }
    const before = install(installArgs("Install test dependencies"));
    assert.notEqual(before.status, 0);
    assert.match(before.stdout + before.stderr, drift === "patch" ? /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/ : /ERR_PNPM_OUTDATED_LOCKFILE/);

    // Capture the publisher's resolution, then reproduce its tracked-file restore
    // and a fresh smoke runner with no installed workspace dependencies.
    success(install(installArgs("Install dependencies")));
    const artifact = path.join(root, "publisher-lock.yaml");
    if (publish.includes("name: Save canary smoke lockfile")) {
      copyFileSync(path.join(root, "pnpm-lock.yaml"), artifact);
    }
    writeFileSync(path.join(root, "pnpm-lock.yaml"), staleLock);
    rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    if (smoke.includes("name: Restore canary smoke lockfile")) {
      copyFileSync(artifact, path.join(root, "pnpm-lock.yaml"));
    }
    success(install(installArgs("Install test dependencies")));
    assert.equal(readFileSync(path.join(root, "node_modules/smoke-fixture-dependency/index.js"), "utf8"), 'module.exports = "published-patch";\n');
    assert.deepEqual(readFileSync(path.join(root, "pnpm-lock.yaml")), readFileSync(artifact));

    // A lockfile from the wrong source still fails closed; restoring an artifact
    // must not disable hash validation or resolve another version in the smoke job.
    patch("different-source");
    const wrongSource = install(installArgs("Install test dependencies"));
    assert.notEqual(wrongSource.status, 0);
    assert.match(wrongSource.stdout + wrongSource.stderr, /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/);
  });
}

test("every lane's tag push degrades to recovery instructions when rejected", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // GITHUB_TOKEN may not create refs pointing at workflow-modifying commits
  // from dispatch or scheduled runs; a rejected tag push after a successful
  // npm publish must surface runbook recovery commands, not a bare error.
  const occurrences = releaseWorkflow.match(/## Tag push rejected/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    "nightly, beta, and stable each carry the recovery summary",
  );
});

test("release smoke workflow extends the container readiness budget for CI", () => {
  const smokeWorkflow = readWorkflow("release-smoke.yml");
  const harness = readFileSync(
    path.join(repoRoot, "scripts/docker-onboard-smoke.sh"),
    "utf8",
  );

  // CI containers cold-install paperclipai and embedded postgres, so the
  // workflow must extend the harness's local-default readiness budget.
  assert.match(smokeWorkflow, /SMOKE_READY_TIMEOUT_SECONDS=\d+/);
  const ciBudget = Number(
    smokeWorkflow.match(/SMOKE_READY_TIMEOUT_SECONDS=(\d+)/)[1],
  );
  assert.ok(
    ciBudget >= 300,
    `CI readiness budget ${ciBudget}s should be at least 300s`,
  );

  assert.match(
    harness,
    /SMOKE_READY_TIMEOUT_SECONDS="\$\{SMOKE_READY_TIMEOUT_SECONDS:-\d+\}"/,
  );
  assert.match(
    harness,
    /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health" "\$SMOKE_READY_TIMEOUT_SECONDS" 1/,
  );
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(
    verifyWorkflow,
    /node \.\/scripts\/release-package-map\.mjs check/,
  );
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  const runnerScripts = JSON.parse(readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8")).scripts;
  const runnerChecks = [...verifyWorkflow.matchAll(/^            checks: (.+)$/gm)]
    .flatMap(([, checks]) => checks.split(" "));
  assert.deepEqual(runnerChecks, runnerScripts["check:all"].split(" && ")
    .map((command) => command.replace(/^pnpm run /, "")));
  assert.match(verifyWorkflow, /pnpm --filter @paperclipai\/paperclip-runner "\$check"/);
  assert.match(verifyWorkflow, /runner_workflow_evals:/);
  assert.match(verifyWorkflow, /runner_chaos_evals:/);
  assert.match(
    verifyWorkflow,
    /uses: \.\/\.github\/workflows\/runner-chaos-evals\.yml/,
  );
  assert.match(
    verifyWorkflow,
    /runner_workflow_evals:[\s\S]*?Install dependencies\n\s+run: pnpm install --no-frozen-lockfile[\s\S]*?Run deterministic Runner workflow scorer tests/,
  );
  assert.match(verifyWorkflow, /pnpm test:runner-workflow-evals/);

  const buildJob = verifyWorkflow.match(/  build:\n[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|$)/)?.[0] ?? "";
  assert.match(buildJob, /persist-credentials: false/);
  assert.doesNotMatch(buildJob, /cache: pnpm/);

  for (const group of ["general-server-without-chat-or-native-runner", "general-chat", "general-workspaces-a", "general-workspaces-b", "general-workspaces-c"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }
  for (const [group, count] of [["general-server-without-chat-or-native-runner", 10], ["general-chat", 3]]) {
    const rows = [...verifyWorkflow.matchAll(new RegExp(`group: ${group}\\n\\s+group_label: [^\\n]+\\n\\s+shard_index: (\\d+)\\n\\s+shard_count: (\\d+)`, "g"))];
    assert.deepEqual(rows.map((row) => [Number(row[1]), Number(row[2])]),
      Array.from({ length: count }, (_, index) => [index, count]));
  }
  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`));
  }

  // workspaces-a splits with Vitest native --shard in pr.yml; release
  // verification must keep the same two-shard coverage.
  for (const shardIndex of [0, 1]) {
    assert.match(
      verifyWorkflow,
      new RegExp(
        `group: general-workspaces-a[\\s\\S]*?shard_index: ${shardIndex}\\n\\s+shard_count: 2`,
      ),
    );
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});

test("release verification builds native test binaries in a required Rust-cached lane", () => {
  const workflow = readWorkflow("release-verify.yml");
  const runnerJob = workflow.match(/  verify_paperclip_runner:\n[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|$)/)?.[0] ?? "";
  assert.equal((runnerJob.match(/- lane: server-integration/g) ?? []).length, 1);
  assert.doesNotMatch(runnerJob, /continue-on-error/);
  assert.match(runnerJob, /timeout-minutes: 20/);
  assert.match(runnerJob, /shared-key: release-runner-v2/);
  assert.match(runnerJob, /cache-workspace-crates: false/);
  assert.match(runnerJob, /cache-bin: false/);
  assert.match(runnerJob, /save-if: \$\{\{ matrix\.lane == 'rust'/);
  assert.match(runnerJob, /Build native server test binaries\n\s+if: \$\{\{ matrix\.lane == 'server-integration' \}\}\n\s+timeout-minutes: 10/);
  assert.match(runnerJob, /pnpm build:rust\n\s+cargo build --release --manifest-path runner\/Cargo\.toml --locked -p paperclip-runner-core --bin paperclip-runnerd --bin fake-codex-app-server/);
  assert.match(runnerJob, /Run native server integration suites\n\s+if: \$\{\{ matrix\.lane == 'server-integration' \}\}\n\s+run: pnpm test:run:general -- --group general-server-native-runner/);
  assert.ok(runnerJob.indexOf("Cache Runner Rust dependencies") < runnerJob.indexOf("Build native server test binaries"));
  assert.ok(runnerJob.indexOf("Build native server test binaries") < runnerJob.indexOf("Run native server integration suites"));

  // The reusable workflow result includes every matrix child. Its caller must
  // await that result without an override that can certify a failed native lane.
  const cloud = readWorkflow("cloud-readiness.yml");
  assert.match(cloud, /verify:[\s\S]*?uses: \.\/\.github\/workflows\/release-verify\.yml/);
  assert.match(cloud, /source_verified:[\s\S]*?needs: \[verify\]/);
  assert.doesNotMatch(cloud, /continue-on-error|always\(\)/);
});

test("Runner eval workflows pin actions and gate paid live execution", () => {
  const actionPinWorkflows = [
    readWorkflow("release-verify.yml"),
    readWorkflow("runner-live-evals.yml"),
    readWorkflow("runner-chaos-evals.yml"),
    readWorkflow("runner-full-stack-e2e.yml"),
    readWorkflow("e2e.yml"),
    readWorkflow("runner-protocol-live-evals.yml"),
    readWorkflow("chat-feature-testops.yml"),
    readWorkflow("chat-completion-testops.yml"),
  ];

  for (const workflow of actionPinWorkflows) {
    const remoteUses = workflow
      .split("\n")
      .filter(
        (line) =>
          /^\s*(?:-\s*)?uses: /.test(line) && !line.includes("uses: ./"),
      );
    assert.ok(
      remoteUses.length > 0,
      "expected at least one remote action reference",
    );
    for (const line of remoteUses) {
      assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s+# .+)?$/);
    }
  }

  const liveWorkflow = actionPinWorkflows[1];
  assert.match(liveWorkflow, /RUNNER_LIVE_EVALS_NIGHTLY_ENABLED == 'true'/);
  assert.match(liveWorkflow, /REF: \$\{\{ github\.ref \}\}/);
  assert.match(liveWorkflow, /refs\/heads\/\$DEFAULT_BRANCH/);
  assert.match(
    liveWorkflow,
    /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(liveWorkflow, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
  assert.match(liveWorkflow, /needs: authorize/);
  assert.match(liveWorkflow, /environment:\n\s+name: runner-e2e-paid/);
  assert.match(
    liveWorkflow,
    /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/,
  );

  const paidWorkflowNames = [
    "e2e.yml",
    "runner-full-stack-e2e.yml",
    "runner-live-evals.yml",
    "runner-protocol-live-evals.yml",
    "chat-feature-testops.yml",
    "chat-completion-testops.yml",
  ];
  const paidWorkflowNameSet = new Set(paidWorkflowNames);
  const providerSecretReference =
    /secrets(?:\.(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|GROK_AUTH_JSON|DAYTONA_API_KEY)\b|\[['"](?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|GROK_AUTH_JSON|DAYTONA_API_KEY)['"]\])/g;
  for (const name of readdirSync(path.join(repoRoot, ".github/workflows"))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = readWorkflow(name);
    if ([...workflow.matchAll(providerSecretReference)].length > 0) {
      assert.ok(
        paidWorkflowNameSet.has(name),
        `${name} must not receive provider credentials`,
      );
    }
  }

  for (const name of paidWorkflowNames) {
    const workflow = readWorkflow(name);
    const triggerHeader = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    assert.doesNotMatch(
      triggerHeader,
      /^\s{2}(?:pull_request|pull_request_target|push|workflow_call|workflow_run):/m,
    );
    assert.match(triggerHeader, /^\s{2}workflow_dispatch:/m);
    assert.match(workflow, /^  authorize:/m);

    const jobBlocks = workflow
      .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
      .split(/\n(?=  [A-Za-z0-9_-]+:\n)/);
    const providerJobs = jobBlocks.filter(
      (block) => [...block.matchAll(providerSecretReference)].length > 0,
    );
    assert.ok(providerJobs.length > 0, `${name} needs a provider-secret job`);
    if (name === "chat-completion-testops.yml") {
      assert.equal(providerJobs.length, 1);
      const assertBoundary = (block) => {
        assert.match(block, /^  chat:\n/);
        assert.match(block, /\n    needs: \[authorize, select, build\]\n/);
        assert.match(block, /\n    if: needs\.authorize\.outputs\.operation == 'evaluate'\n/);
        assert.match(block, /\n    environment: runner-e2e-private-paid\n/);
        assert.match(block, /\n      - \*checkout\n      - \*node\n      - \*guard\n/);
        assert.match(block, /chat-completion-testops-cli\.mjs verify-selection/);
        assert.match(block, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
        assert.match(block, /--id "\$\{\{ matrix\.executionId \}\}" --max-parallel 1 --max-automatic-retries 0/);
        assert.match(block, /PAPERCLIP_CHAT_COMPLETION_TESTOPS: v1/);
        assert.match(block, /max-parallel: 1/);
        assert.doesNotMatch(block, /ALLURE_TOKEN/);
        assert.equal([...block.matchAll(providerSecretReference)].length, 1);
        assert.ok(block.indexOf("      - *guard") < block.search(providerSecretReference));
        assert.ok(block.indexOf("chat-completion-testops-cli.mjs verify-selection") < block.search(providerSecretReference));
      };
      const block = providerJobs[0]; assertBoundary(block);
      assert.equal([...workflow.matchAll(providerSecretReference)].length, 1);
      for (const mutant of [
        block.replace("needs: [authorize, select, build]", "needs: [authorize, build]"),
        block.replace("environment: runner-e2e-private-paid", "environment: unprotected"),
        block.replace("      - *guard\n", ""),
        block.replace("chat-completion-testops-cli.mjs verify-selection", "chat-completion-testops-cli.mjs unverified-selection"),
        block.replace('--id "${{ matrix.executionId }}"', "--all"),
        block.replace("PAPERCLIP_CHAT_COMPLETION_TESTOPS: v1", "PAPERCLIP_CHAT_COMPLETION_TESTOPS: unknown"),
      ]) assert.throws(() => assertBoundary(mutant));
      continue;
    }
    if (name === "chat-feature-testops.yml") {
      assert.equal(providerJobs.length, 1);
      const assertBoundary = (block) => {
        assert.match(block, /^  chat:\n/);
        assert.match(block, /\n    needs: \[authorize, select, build\]\n/);
        assert.match(block, /\n    if: needs\.authorize\.outputs\.operation == 'evaluate'\n/);
        assert.match(block, /\n    environment: runner-e2e-private-paid\n/);
        assert.match(block, /\n      - \*checkout\n      - \*node\n      - \*guard\n/);
        assert.match(block, /testops-chat-reporter\.mjs verify-selection chat-testops-selection\/testops-selection\.json/);
        assert.match(block, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
        assert.match(block, /--id chat-features\.runner-opencode-deepseek-1017\.local\.create-backlog --max-parallel 1 --max-automatic-retries 0/);
        assert.doesNotMatch(block, /ALLURE_TOKEN/);
        assert.equal([...block.matchAll(providerSecretReference)].length, 1);
        assert.ok(block.indexOf("      - *guard") < block.search(providerSecretReference));
        assert.ok(block.indexOf("testops-chat-reporter.mjs verify-selection") < block.search(providerSecretReference));
      };
      const block = providerJobs[0];
      assertBoundary(block);
      assert.equal([...workflow.matchAll(providerSecretReference)].length, 1);
      assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(workflow, /run: node tests\/runner-e2e\/testops-chat-dispatch\.ts/);
      assert.match(workflow, /TESTOPS_ALLOWED_ACTOR_IDS: \$\{\{ vars\.RUNNER_E2E_ALLOWED_ACTOR_IDS \}\}/);
      for (const mutant of [
        block.replace("needs: [authorize, select, build]", "needs: [authorize, build]"),
        block.replace("environment: runner-e2e-private-paid", "environment: unprotected"),
        block.replace("      - *guard\n", ""),
        block.replace("testops-chat-reporter.mjs verify-selection", "testops-chat-reporter.mjs unverified-selection"),
        block.replace("OPENROUTER_API_KEY:", "ALLURE_TOKEN:"),
        block.replace("--id chat-features.runner-opencode-deepseek-1017.local.create-backlog", "--id chat-features.runner-opencode.local.create-backlog"),
      ]) assert.throws(() => assertBoundary(mutant));
      continue;
    }
    for (const block of providerJobs) {
      if (name === "runner-protocol-live-evals.yml") {
        assert.ok(block.includes("name: ${{ needs.authorize.outputs.accounting_mode == 'controlled' && 'runner-e2e-private-paid' || 'runner-e2e-paid' }}"));
        assert.ok(block.includes("test '${{ needs.authorize.outputs.target_sha }}' = \"$GITHUB_SHA\""));
        assert.ok(block.includes('test "$GITHUB_RUN_ATTEMPT" = 1'));
      } else assert.match(block, /\n    environment:\n      name: runner-e2e-paid\n/);
      assert.match(
        block,
        /\n    steps:(?: &[A-Za-z0-9_-]+)?\n(?:\s*\n)*      - name: Reauthorize[^\n]*\n/,
        `${name} must reauthorize as the first provider-job step`,
      );
      const reauthorize = block.indexOf("      - name: Reauthorize");
      assert.ok(reauthorize > 0);
      assert.ok(block.indexOf("actions/checkout@") > reauthorize);
      assert.ok(block.search(providerSecretReference) > reauthorize);
      assert.match(block, /github\.actor_id/);
      assert.match(block, /github\.triggering_actor/);
      assert.match(block, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
      assert.match(block, /refs\/heads\/\$DEFAULT_BRANCH/);
      assert.doesNotMatch(block, /^\s+cache: pnpm$/m);
    }
  }

  const fullStackWorkflow = readWorkflow("runner-full-stack-e2e.yml");
  for (const [secret, condition] of Object.entries({
    OPENAI_API_KEY: "matrix.credentialName == 'OPENAI_API_KEY'",
    ANTHROPIC_API_KEY: "matrix.credentialName == 'ANTHROPIC_API_KEY'",
    OPENROUTER_API_KEY: "matrix.credentialName == 'OPENROUTER_API_KEY'",
    DAYTONA_API_KEY: "matrix.environmentId == 'daytona'",
  })) {
    assert.ok(
      fullStackWorkflow.includes(
        `${secret}: \${{ ${condition} && secrets.${secret} || '' }}`,
      ),
      `${secret} must be scoped to only the matrix cells that require it`,
    );
  }
  const historyPublisher = fullStackWorkflow.slice(
    fullStackWorkflow.indexOf("  publish_history:"),
    fullStackWorkflow.indexOf("  pages:"),
  );
  assert.doesNotMatch(historyPublisher, /^\s+cache: pnpm$/m);

  for (const name of [
    "runner-full-stack-e2e.yml",
    "runner-live-evals.yml",
    "runner-protocol-live-evals.yml",
  ]) {
    const workflow = readWorkflow(name);
    const crons = [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    if (name === "runner-full-stack-e2e.yml") {
      assert.deepEqual(crons, ["47 8 * * *", "47 9 * * 0"]);
      assert.ok(workflow.includes("vars.RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED == 'true' && vars.RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED == 'true'"));
      assert.ok(workflow.includes("Prepare bounded campaign before credentials"));
      assert.ok(workflow.includes("--max-parallel 1 --max-automatic-retries 0"));
      const catalog = workflow.slice(workflow.indexOf("  catalog:"), workflow.indexOf("  daytona_image:"));
      assert.ok(catalog.includes("EVAL_OPERATING_OVERHEAD_JSON: ${{ vars.RUNNER_E2E_OPERATING_OVERHEAD_JSON }}"));
      assert.ok(catalog.includes("operating_overhead: ${{ steps.catalog.outputs.operating_overhead }}"));
      const prepare = workflow.slice(workflow.indexOf("      - name: Prepare bounded campaign before credentials"), workflow.indexOf("      - name: Run bounded campaign and retain feedback review"));
      assert.ok(prepare.includes("EVAL_OPERATING_OVERHEAD_JSON: ${{ needs.catalog.outputs.operating_overhead }}"));
      assert.ok(prepare.includes("EVAL_TEST_RUNNER: ${{ needs.authorize.outputs.test_runner }}"));
      assert.ok(!prepare.includes("vars.RUNNER_E2E_OPERATING_OVERHEAD_JSON"));
    } else {
      assert.equal(crons.length, 1, `${name} must have one schedule`);
      assert.match(crons[0], /^\d{1,2} \d{1,2} \* \* 0$/);
    }
  }

  const chaosWorkflow = actionPinWorkflows[2];
  const runnerBlock = chaosWorkflow.match(
    /- name: Run Runner fault and replay suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Build server test dependencies)/,
  )?.[1];
  const serverBlock = chaosWorkflow.match(
    /- name: Run server finalization and recovery suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Upload chaos eval bundle)/,
  )?.[1];
  assert.ok(runnerBlock, "expected Runner chaos test command");
  assert.ok(serverBlock, "expected server chaos test command");
  for (const [base, block] of [
    [path.join(repoRoot, "packages/paperclip-runner"), runnerBlock],
    [path.join(repoRoot, "server"), serverBlock],
  ]) {
    const listedTestPaths =
      block.match(/src\/[A-Za-z0-9_./-]+\.test\.ts/g) ?? [];
    assert.ok(listedTestPaths.length > 0, "expected chaos workflow test paths");
    assert.equal(
      new Set(listedTestPaths).size,
      listedTestPaths.length,
      "chaos workflow test paths must be unique",
    );
    for (const testPath of listedTestPaths) {
      assert.ok(
        existsSync(path.join(base, testPath)),
        `chaos workflow test path does not exist: ${testPath}`,
      );
    }
  }
});


test("direct Grok qualification installs the pinned binary and scopes the selected credential", () => {
  const workflow = readWorkflow("runner-protocol-live-evals.yml");
  assert.ok(workflow.includes("XAI_API_KEY: ${{ matrix.credentialName == 'XAI_API_KEY' && secrets.XAI_API_KEY || '' }}"));
  assert.ok(workflow.includes("if [ -f packages/paperclip-runner/scripts/provision-grok.mjs ]; then"));
  assert.ok(workflow.indexOf("sudo node packages/paperclip-runner/scripts/provision-grok.mjs /opt/paperclip/providers/grok/1.0.13/grok") < workflow.indexOf("pnpm --filter @paperclipai/paperclip-runner deploy --prod"));
  assert.ok(workflow.includes("PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: ${{ matrix.credentialName == 'PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET' && secrets.GROK_AUTH_JSON || '' }}"));
  assert.equal((workflow.match(/secrets\.GROK_AUTH_JSON/gu) ?? []).length, 1);
});

test("direct protocol concurrency override only lowers the configured ceiling", () => {
  const workflow = readWorkflow("runner-protocol-live-evals.yml");
  const start = workflow.indexOf('          if [ -n "${REQUESTED_MAX_PARALLEL:-}" ]; then');
  const end = workflow.indexOf("          node packages/paperclip-runner/scripts/runner-protocol-eval-campaign.mjs catalog", start);
  assert.ok(start > 0 && end > start);
  const script = workflow.slice(start, end) + '\nprintf "%s" "$MAX_PARALLEL"\n';
  for (const [requested, expected] of [["", "8"], ["2", "2"], ["8", "8"], ["1", null], ["9", null], ["0", null], ["-1", null], ["2.5", null], ["garbage", null], ["9999999999999999999999", null]]) {
    const result = spawnSync("bash", ["-eu", "-c", script], {
      env: { ...process.env, MAX_PARALLEL: "8", REQUESTED_MAX_PARALLEL: requested }, encoding: "utf8",
    });
    assert.equal(result.status, expected === null ? 1 : 0, requested);
    if (expected !== null) assert.equal(result.stdout, expected);
  }
});

test("release daemon production uses exact-source native hosts and no publisher or provider permissions", () => {
  const workflow = readWorkflow("release-verify.yml");
  const producer = workflow.split("  runner_binaries:\n")[1];
  const targets = workflow.split("  runner_binary_targets:\n")[1].split("  runner_binaries:\n")[0];
  for (const [target, host] of [["linux-arm64", "ubuntu-24.04-arm"], ["darwin-arm64", "macos-15"], ["darwin-x64", "macos-15-intel"]]) {
    assert.ok(targets.includes(`'${target}': '${host}'`));
  }
  assert.match(producer, /matrix: \$\{\{ fromJSON\(needs.runner_binary_targets.outputs.matrix\) \}\}/);
  assert.match(targets, /Unknown exact-source daemon platform contract/);
  assert.match(targets, /release-runner-targets\.json/);
  assert.match(targets, /execFileSync\('git', \['show', source \+ ':' \+ file\]/);
  assert.doesNotMatch(targets, /import .*from '\.\/|await import\(|\beval\(|new Function/);
  assert.doesNotMatch(targets, /secrets\.|id-token: write|contents: write|npm publish|environment:/);
  assert.match(producer, /persist-credentials: false/);
  assert.match(producer, /contents: read/);
  assert.doesNotMatch(producer, /secrets\.|id-token: write|contents: write|npm publish|environment:/);
  assert.match(producer, /\[\[ "\$SOURCE_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  assert.match(producer, /git rev-parse HEAD/);
  assert.match(producer, /process.platform \+ "-" \+ process.arch/);
  assert.match(producer, /\['native', \['build:binary'\]/);
  const runner = JSON.parse(readFileSync(path.join(repoRoot, 'packages/paperclip-runner/package.json'), 'utf8'));
  assert.match(runner.scripts['build:binary'], /cargo build --release --manifest-path runner\/Cargo.toml --locked/);
  assert.match(runner.scripts['build:binary'], /&& node scripts\/stage-runner-binary.mjs$/);
  assert.match(producer, /stage-release-runner-binaries.mjs record/);
  for (const job of ["runner_chaos_evals", "typecheck", "general_tests", "serialized_tests", "runner_workflow_evals", "verify_paperclip_runner", "build"]) {
    assert.ok(workflow.includes(`${job}:\n    if: \${{ !inputs.runner_binaries_only }}`));
  }
  const release = readWorkflow("release.yml");
  const source = release.split("  release_runner_source:\n")[1].split(/\n  [a-z_]+:\n/)[0];
  const binaries = release.split("  release_runner_binaries:\n")[1].split(/\n  [a-z_]+:\n/)[0];
  assert.match(source, /needs: \[verify_canary, select_nightly, select_beta, preflight_stable\]/);
  assert.match(source, /!cancelled\(\)/);
  assert.match(binaries, /needs: release_runner_source/);
  assert.match(binaries, /ref: \$\{\{ needs\.release_runner_source\.outputs\.sha \}\}/);
  assert.match(binaries, /runner_binaries_only: true/);
  const condition = binaries.match(/^    if: (.+)$/m)?.[1].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.match(condition, /^!cancelled\(\) && needs\.release_runner_source\.result == 'success' && needs\.release_runner_source\.outputs\.required == 'true'$/,
    "Native compilation must bypass deliberately skipped channel ancestors and require successful exact-source selection");
  const laneJobs = ["verify_canary", "select_nightly", "select_beta", "preflight_stable"];
  for (const activeLane of laneJobs) {
    for (const [result, required, cancelled, expected] of [
      ["success", "true", false, true], ["failure", "true", false, false],
      ["cancelled", "true", false, false], ["skipped", "true", false, false],
      ["success", "false", false, false], ["success", undefined, false, false],
      ["success", "true", true, false],
    ]) {
      const needs = Object.fromEntries(laneJobs.map(job => [job, { result: job === activeLane ? "success" : "skipped" }]));
      needs.release_runner_source = { result, outputs: { required } };
      assert.equal(Object.values(needs).filter(job => job.result === "skipped").length, result === "skipped" ? 4 : 3);
      assert.equal(runInNewContext(condition, { cancelled: () => cancelled, needs }), expected,
        `${activeLane}: source=${result}, required=${required}, cancelled=${cancelled}`);
    }
  }
  for (const job of ["publish_canary", "publish_nightly", "publish_beta", "preview_stable", "publish_stable"]) {
    const block = release.split(`  ${job}:\n`)[1].split(/\n  [a-z_]+:\n/)[0];
    assert.match(block, /needs: .*release_runner_binaries/);
    assert.match(block, /pattern: \$\{\{ needs.release_runner_binaries.outputs.runner_artifact_prefix \}\}-\*/);
    assert.match(block, /PAPERCLIP_RELEASE_RUNNER_ARTIFACTS_DIR/);
  }
  const script = readFileSync(path.join(repoRoot, 'scripts/release.sh'), 'utf8');
  assert.ok(script.indexOf('assemble-daemons "$PAPERCLIP_RELEASE_RUNNER_ARTIFACTS_DIR"') < script.indexOf('scripts/build-standalone-public-packages.mjs'));
  assert.match(script, /cp -R .*paperclip-runner\/dist\/bin\/\." .*server\/dist\/vendor\/paperclip-runner\/bin\//);
  assert.match(script, /elif \[ "\$dry_run" = false \]; then[\s\S]*?release_fail "Public releases require/);
});

function nativeProducer() {
  return readWorkflow('release-verify.yml').split('  runner_binaries:\n')[1];
}

test('native provider packs and the image use the same exact Node version', () => {
  const version = nativeProducer().match(/node-version: ([0-9.]+)/)?.[1];
  assert.equal(version, '24.21.0');
  const image = readFileSync(path.join(repoRoot, 'docker/daytona-runner/Dockerfile'), 'utf8');
  assert.ok(image.includes(`FROM node:${version}-bookworm@sha256:`));
});

test('native dependency caches are target-bound and unmerged master callers cannot save them', () => {
  const producer = nativeProducer();
  const cache = producer.split('      - name: Cache native Rust dependencies\n')[1].split('\n      - ')[0];
  assert.match(cache, /Swatinem\/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6/);
  assert.match(cache, /workspaces: \$\{\{ steps.native_rust_workspace.outputs.path \}\} -> target/);
  assert.match(cache, /shared-key: release-native-v2-\$\{\{ matrix.host \}\}-\$\{\{ matrix.target \}\}-\$\{\{ hashFiles\('packages\/paperclip-runner\/protocol\/\*\*', 'packages\/paperclip-runner\/src\/\*\*', 'packages\/paperclip-runner\/\*.json'\) \}\}/);
  for (const option of ['cache-workspace-crates', 'cache-bin', 'cache-on-failure']) {
    assert.match(cache, new RegExp(option + ': false'));
  }
  const expression = cache.match(/save-if: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(expression, 'cache writes need a separate source trust gate');
  const canSave = new Function('github', 'inputs', `return (${expression});`);
  const github = { repository: 'paperclipai/paperclip', repository_id: '1170821064', event_name: 'push', ref: 'refs/heads/master', sha: 'a'.repeat(40) };
  assert.equal(canSave(github, { ref: github.sha }), true);
  for (const [overrides, input] of [
    [{}, 'b'.repeat(40)], [{}, ''],
    [{ event_name: 'workflow_dispatch' }, github.sha],
    [{ event_name: 'workflow_dispatch' }, 'b'.repeat(40)],
    [{ event_name: 'pull_request', ref: 'refs/pull/123/merge' }, github.sha],
    [{ ref: 'refs/heads/topic' }, github.sha],
    [{ repository: 'fork/paperclip' }, github.sha],
    [{ repository_id: '1' }, github.sha],
  ]) assert.equal(canSave({ ...github, ...overrides }, { ref: input }), false);
  assert.match(producer, /pinned="\$HOME\/paperclip-runner-rust"/);
  assert.match(producer, /ln -s "\$GITHUB_WORKSPACE\/packages\/paperclip-runner\/runner" "\$pinned"/);
  assert.match(producer, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(producer, /cache-hit|continue-on-error/);
  assert.ok(producer.indexOf('Bind immutable producer source and target') < producer.indexOf('Cache native Rust dependencies'));
  assert.ok(producer.indexOf('Build TypeScript contract and host daemon concurrently') < producer.indexOf('Record actual daemon metadata and immutable bytes'));
});

function nativePreparationScript() {
  const step = nativeProducer().split('      - name: Build TypeScript contract and host daemon concurrently\n')[1].split('\n      - ')[0];
  const script = step.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];
  assert.ok(script);
  return script.replace(/^ {10}/gm, '');
}

const fixtureProcessGone = pid => {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  try { return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};
const waitForFixture = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(label);
};

async function withNativePreparationFixture(mode, check) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-preparation-')));
  let controller;
  try {
    for (const directory of ['scripts', 'tools', 'packages/paperclip-runner', 'logs']) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const helper of ['prefetch-child.mjs', 'prefetch-supervisor.mjs']) {
      copyFileSync(path.join(repoRoot, 'scripts', helper), path.join(root, 'scripts', helper));
    }
    writeFileSync(path.join(root, 'prepare.mjs'), nativePreparationScript());
    writeFileSync(path.join(root, 'tools/pnpm'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.FIXTURE_ROOT;
const name = process.argv.includes('build:binary') ? 'native' : 'typescript';
writeFileSync(join(root, name + '.started'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }));
const wait = setInterval(() => {
  if (!existsSync(join(root, 'native.started')) || !existsSync(join(root, 'typescript.started'))) return;
  clearInterval(wait);
  if (process.env.FIXTURE_MODE === 'success') {
    setTimeout(() => { writeFileSync(join(root, name + '.finished'), 'joined'); console.log(name + ' complete'); }, 150);
    return;
  }
  const child = spawn(process.execPath, ['-e', \
    "const fs=require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => fs.writeFileSync(process.argv[2], String(Date.now())), 25)",\
    join(root, name + '.descendant'), join(root, name + '.writing')], { stdio: 'inherit' });
  child.on('exit', () => process.exit(0));
  const barrier = setInterval(() => {
    if (!existsSync(join(root, 'native.descendant')) || !existsSync(join(root, 'typescript.descendant'))) return;
    clearInterval(barrier);
    if (process.env.FIXTURE_MODE === name) { console.error(name + ' failed'); process.exit(23); }
  }, 10);
}, 10);
`, { mode: 0o755 });
    controller = spawn(process.execPath, ['prepare.mjs'], { cwd: root, env: {
      ...process.env, PATH: `${path.join(root, 'tools')}:${process.env.PATH}`, RUNNER_TEMP: path.join(root, 'logs'), FIXTURE_ROOT: root, FIXTURE_MODE: mode,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    controller.stdout.on('data', chunk => { stdout += chunk; });
    controller.stderr.on('data', chunk => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => {
      controller.once('error', reject);
      controller.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    await check({ root, controller, completed });
  } finally {
    if (controller?.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
    for (const name of ['native', 'typescript']) {
      for (const filename of [name + '.started', name + '.descendant']) {
        const file = path.join(root, filename);
        if (!existsSync(file)) continue;
        const data = readFileSync(file, 'utf8');
        const pid = filename.endsWith('.started') ? JSON.parse(data).pid : Number(data);
        if (!fixtureProcessGone(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('native preparation overlaps independent outputs and joins both before recording', async () => {
  await withNativePreparationFixture('success', async ({ root, completed }) => {
    const result = await completed;
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['native', 'typescript']) assert.equal(readFileSync(path.join(root, name + '.finished'), 'utf8'), 'joined');
    assert.equal(JSON.parse(readFileSync(path.join(root, 'native.started'), 'utf8')).cwd, path.join(root, 'packages/paperclip-runner'));
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'native.started'), 'utf8')).args, ['build:binary']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'typescript.started'), 'utf8')).args, ['--filter', '@paperclipai/paperclip-runner', 'build:typescript']);
    const results = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.deepEqual(results.map(item => [item.build, item.status, item.exitCode]), [['typescript', 'fulfilled', 0], ['native', 'fulfilled', 0]]);
  });
});

for (const name of ['typescript', 'native']) {
  test(`${name} preparation failure fails the join and retires both owned process trees`, async () => {
    await withNativePreparationFixture(name, async ({ root, completed }) => {
      const result = await completed;
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(name + ' prefetch failed \\(exit 23\\)'));
      const results = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.equal(results.length, 2);
      assert.ok(results.every(item => item.status === 'rejected'));
      for (const build of ['native', 'typescript']) {
        const pid = Number(readFileSync(path.join(root, build + '.descendant'), 'utf8'));
        await waitForFixture(() => fixtureProcessGone(pid), build + ' descendant outlived failed join');
      }
    });
  });
}

test('canceling native preparation retires both supervisors and their descendants', { skip: process.platform === 'win32' }, async () => {
  await withNativePreparationFixture('cancel', async ({ root, controller, completed }) => {
    await waitForFixture(() => ['native', 'typescript'].every(name => existsSync(path.join(root, name + '.descendant'))), 'both native build trees must start');
    controller.kill('SIGTERM');
    const result = await completed;
    assert.equal(result.signal, 'SIGTERM');
    for (const name of ['native', 'typescript']) {
      const pid = Number(readFileSync(path.join(root, name + '.descendant'), 'utf8'));
      await waitForFixture(() => fixtureProcessGone(pid), name + ' descendant outlived cancellation');
    }
  });
});

test("premerge native qualification consumes the same Linux-packed npm bytes without publishing", () => {
  const smoke = readWorkflow("release-smoke.yml");
  assert.match(smoke, /smoke_service:\n\s+if: inputs.qualification_source_sha == ''/);
  assert.match(smoke, /smoke:\n\s+if: inputs.qualification_source_sha == ''/);
  const qualification = smoke.split("  qualification_daemons:\n")[1];
  assert.doesNotMatch(qualification, /secrets\.|npm publish|id-token: write|contents: write|continue-on-error/);
  assert.match(qualification, /runner_binaries_only: true/);
  assert.match(qualification, /PAPERCLIP_RUNNER_PUBLIC_PACKS_DIR/);
  assert.match(qualification, /if: \$\{\{ !cancelled\(\) && steps.pack_identity.outputs.available == 'true' \}\}/);
  assert.match(qualification, /name: \$\{\{ inputs.artifact_name \}\}-public-packages/);
  assert.match(qualification, /--mac-consumer/);
  assert.match(qualification, /--linux-arm64-consumer/);
  assert.match(qualification, /fromJSON\(needs.qualification_daemons.outputs.native_consumer_matrix\)/);
  assert.match(qualification, /pnpm install --ignore-scripts --no-frozen-lockfile/);
});

test("native ARM qualification prepares its scoped distro sandbox before the existing consumer", () => {
  const smoke = readWorkflow("release-smoke.yml");
  const native = smoke.split("  qualification_native:\n")[1];
  const preparation = native.split("      - name: Prepare Linux ARM sandbox prerequisites\n")[1].split("\n      - ")[0];
  assert.match(preparation, /if: \$\{\{ matrix\.target == 'linux-arm64' \}\}/);
  assert.match(preparation, /timeout-minutes: 5/);
  assert.match(preparation, /bash \.qualification-tooling\/scripts\/prepare-linux-arm64-qualification\.sh/);
  const tooling = native.split("      - name: Checkout immutable ARM qualification tooling\n")[1].split("\n      - ")[0];
  assert.match(tooling, /if: \$\{\{ matrix\.target == 'linux-arm64' \}\}/);
  assert.match(tooling, /repository: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(tooling, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(tooling, /sparse-checkout: scripts\/prepare-linux-arm64-qualification\.sh/);
  assert.match(tooling, /sparse-checkout-cone-mode: false/);
  assert.match(tooling, /persist-credentials: false/);
  assert.doesNotMatch(tooling + preparation, /github\.workflow_sha|github\.sha|ref: (?:master|main)|ref: \$\{\{ inputs\.qualification_source_sha/);
  assert.ok(native.indexOf("Checkout immutable ARM qualification tooling") < native.indexOf("Prepare Linux ARM sandbox prerequisites"));
  assert.ok(native.indexOf("Prepare Linux ARM sandbox prerequisites") < native.indexOf("Verify host identity and actual clean npm consumer"));
  assert.match(native, /path: \|\n\s+\$\{\{ runner\.temp \}\}\/native-public-install\.json\n\s+\$\{\{ runner\.temp \}\}\/paperclip-arm-bwrap-prerequisite\//);
  assert.doesNotMatch(smoke.split("  qualification_daemons:\n")[0], /prepare-linux-arm64-qualification/,
    "ordinary service and Docker smoke keep their existing setup");
});

test("ARM qualification binds separate product and reusable-workflow revisions even when the product lacks the helper", { skip: process.platform === "win32" }, () => {
  const native = readWorkflow("release-smoke.yml").split("  qualification_native:\n")[1];
  const step = native.split("      - name: Prepare Linux ARM sandbox prerequisites\n")[1].split("\n      - ")[0];
  const script = step.split("        run: |\n")[1].split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  const root = mkdtempSync(path.join(tmpdir(), "arm-separate-tooling-"));
  try {
    const tools = path.join(root, "tools"); mkdirSync(tools);
    const tooling = path.join(root, ".qualification-tooling", "scripts"); mkdirSync(tooling, { recursive: true });
    const helper = 'printf "%s\\n" "$TOOLING_SHA" > "$FIXTURE_PREPARED"\n';
    writeFileSync(path.join(tooling, "prepare-linux-arm64-qualification.sh"), helper);
    writeFileSync(path.join(tools, "git"), '#!/bin/bash\nif [[ "$1" == -C ]]; then printf "%s\\n" "$FIXTURE_TOOLING_HEAD"; else printf "%s\\n" "$FIXTURE_PRODUCT_HEAD"; fi\n', { mode: 0o755 });
    const productSha = "a".repeat(40), toolingSha = "b".repeat(40);
    for (const [productHead, toolingHead, expectedStatus] of [[productSha, toolingSha, 0], ["c".repeat(40), toolingSha, 1], [productSha, "c".repeat(40), 1], [productSha, "invalid", 1]]) {
      const report = path.join(root, "report"); mkdirSync(report);
      const prepared = path.join(root, "prepared");
      const result = spawnSync("/bin/bash", ["-c", script], { cwd: root, encoding: "utf8", env: {
        PATH: `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: report,
        SOURCE_SHA: productSha, TOOLING_SHA: toolingSha, TOOLING_REPOSITORY: "paperclipai/paperclip",
        TOOLING_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/release-smoke.yml@refs/heads/qualification",
        TOOLING_WORKFLOW_PATH: ".github/workflows/release-smoke.yml",
        FIXTURE_PRODUCT_HEAD: productHead, FIXTURE_TOOLING_HEAD: toolingHead, FIXTURE_PREPARED: prepared,
        GITHUB_REPOSITORY: "different/caller", GITHUB_SHA: "d".repeat(40),
      } });
      assert.equal(result.status, expectedStatus, result.stderr);
      assert.equal(existsSync(path.join(root, "scripts", "prepare-linux-arm64-qualification.sh")), false);
      assert.equal(existsSync(prepared), expectedStatus === 0);
      if (expectedStatus === 0) {
        assert.equal(readFileSync(prepared, "utf8").trim(), toolingSha);
        const identity = JSON.parse(readFileSync(path.join(report, "paperclip-arm-bwrap-prerequisite", "qualification-identity.json"), "utf8"));
        assert.equal(identity.productSourceSha, productSha);
        assert.equal(identity.toolingSourceSha, toolingSha);
        assert.equal(identity.toolingRepository, "paperclipai/paperclip");
        assert.equal(identity.toolingWorkflowPath, ".github/workflows/release-smoke.yml");
        assert.equal(identity.helperSha256, createHash("sha256").update(helper).digest("hex"));
      }
      rmSync(report, { recursive: true, force: true });
      rmSync(prepared, { force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Linux ARM prerequisite setup rejects other hosts before invoking tools and preserves scoped security", { skip: process.platform === "win32" }, () => {
  const helper = path.join(repoRoot, "scripts/prepare-linux-arm64-qualification.sh");
  const source = readFileSync(helper, "utf8");
  const root = mkdtempSync(path.join(tmpdir(), "arm-prerequisite-guard-"));
  try {
    const tools = path.join(root, "tools"); mkdirSync(tools);
    const sentinel = path.join(root, "invoked");
    for (const command of ["dpkg", "uname", "mkdir", "mktemp", "sysctl", "sudo"]) {
      writeFileSync(path.join(tools, command), '#!/bin/bash\nprintf "%s\\n" "$0" >> "$PREREQUISITE_SENTINEL"\nexit 85\n', { mode: 0o755 });
    }
    for (const [actions, runnerOs] of [["", "Linux"], ["false", "Linux"], ["true", "macOS"], ["true", "Windows"]]) {
      const result = spawnSync("/bin/bash", [helper], { encoding: "utf8", env: {
        PATH: tools, GITHUB_ACTIONS: actions, RUNNER_OS: runnerOs, RUNNER_TEMP: root, PREREQUISITE_SENTINEL: sentinel,
      } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires a GitHub Actions Linux runner/);
      assert.equal(existsSync(sentinel), false, "host guard must precede every external tool");
      assert.equal(existsSync(path.join(root, "paperclip-arm-bwrap-prerequisite")), false);
    }
    assert.ok(source.indexOf('"${GITHUB_ACTIONS:-}" != true') < source.indexOf(". /etc/os-release"));
    assert.match(source, /-o Acquire::AllowInsecureRepositories=false/);
    assert.match(source, /download "\$package_name=\$package_version"/);
    assert.match(source, /printf '%s  %s\\n' "\$package_sha256" "\$package_file" \| sha256sum -c -/);
    assert.match(source, /dpkg-deb --fsys-tarfile "\$package_file"/);
    assert.match(source, /tar -xO \.\/usr\/bin\/bwrap/);
    assert.match(source, /11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9/);
    assert.ok(source.indexOf('test ! -L "$target"') < source.indexOf('sudo install -o root -g root -m 0644 "$stock_profile" "$target"'));
    assert.match(source, /timeout 15s sudo "\$parser" -r "\$target"/);
    for (const setting of ["userns", "apparmor", "clone"]) assert.ok(source.includes(`test "$after_${setting}" = "$before_${setting}"`));
    const aptCommands = source.replace(/\\\n\s*/g, " ").split("\n").filter(line => /\bapt-get\b/.test(line));
    assert.equal(aptCommands.length, 2, "only signed-index update and download may invoke APT");
    assert.match(aptCommands[0], /\bupdate\b/);
    assert.match(aptCommands[1], /\bdownload\b/);
    for (const command of aptCommands) assert.doesNotMatch(command, /\b(?:install|upgrade|remove|purge)\b/);
    assert.doesNotMatch(source, /apt-get[^\n]* install|\bdpkg(?:-deb)?\s+(?:-i|--install|--unpack)|sysctl\s+(?:-w|--system)|\baa-disable\b|\bsetcap\b|systemctl|--no-sandbox/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact-source daemon matrices read inert data and never execute preview runner selection", () => {
  const workflow = readWorkflow("release-verify.yml");
  const step = workflow.split('      - name: Preserve the immutable source\'s platform contract')[1].split('\n  runner_binaries:')[0];
  const script = step.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const root = mkdtempSync(path.join(tmpdir(), 'release-target-contract-'));
  try {
    const environment = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const git = args => {
      const result = spawnSync('git', args, { cwd: root, env: environment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const template = path.join(root, 'empty-template'); mkdirSync(template);
    git(['init', '-q', '--template=' + template]);
    const source = path.join(root, 'packages/paperclip-runner/scripts/stage-release-runner-binaries.mjs');
    const dataFile = path.join(root, 'packages/paperclip-runner/release-runner-targets.json');
    mkdirSync(path.dirname(source), { recursive: true });
    const output = path.join(root, 'outputs'), marker = path.join(root, 'candidate-executed');
    const historical = ['darwin-arm64', 'darwin-x64', 'linux-x64'];
    const current = [...historical, 'linux-arm64'];
    const contract = targets => JSON.stringify({ schema: 'paperclip.runner.release-targets.v1', targets });
    const malicious = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nwriteFileSync(process.env.GITHUB_OUTPUT, 'matrix={"include":[{"target":"linux-x64","host":"runs-on/fleet=paperclip-post-merge-x64/env=public-ci"}]}\\n');\nprocess.exit(0);\n`;
    const pin = (module, data) => {
      rmSync(dataFile, { force: true });
      writeFileSync(source, module);
      if (data !== undefined) writeFileSync(dataFile, data);
      git(['add', 'packages']);
      git(['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        'commit', '-qm', 'Fixture', '--allow-empty']);
      return git(['rev-parse', 'HEAD']);
    };
    const run = sha => {
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: root, encoding: 'utf8', env: {
        ...environment, SOURCE_SHA: sha, GITHUB_OUTPUT: output,
      } });
      assert.equal(existsSync(marker), false, 'Candidate code must never execute while selecting runners');
      return result;
    };
    const assertMatrix = targets => {
      const data = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const index = line.indexOf('='); return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
      }));
      assert.deepEqual(data.matrix.include.map(row => row.target), targets);
      assert.deepEqual(data.native_consumers.include.map(row => row.target), targets.filter(target => target !== 'linux-x64'));
      const hosts = { 'linux-x64': targets.length === 4 ? 'ubuntu-24.04' : 'ubuntu-latest',
        'linux-arm64': 'ubuntu-24.04-arm', 'darwin-arm64': 'macos-15', 'darwin-x64': 'macos-15-intel' };
      for (const row of data.matrix.include) assert.equal(row.host, hosts[row.target], 'Only workflow-owned public hosts may be selected');
    };
    for (const [targets, module, data] of [
      [historical, `export const RELEASE_RUNNER_TARGETS = ${JSON.stringify(historical)};`, undefined],
      [current, `${malicious}export const RELEASE_RUNNER_TARGETS = Object.freeze(${JSON.stringify(current)});`, undefined],
      [historical, malicious, contract(historical)],
      [current, malicious, contract(current)],
    ]) {
      const result = run(pin(module, data));
      assert.equal(result.status, 0, result.stderr);
      assertMatrix(targets);
    }
    const sha = pin(malicious, contract(current));
    writeFileSync(dataFile, contract(['runs-on/fleet=paperclip-post-merge-x64/env=public-ci']));
    assert.equal(run(sha).status, 0, 'Read the immutable git blob, not a changed checkout file');
    assertMatrix(current);
    assert.equal(run('a'.repeat(40)).status, 1, 'Wrong checked-out source must fail before output');
    assert.equal(readFileSync(output, 'utf8'), '');
    for (const data of [
      contract(['linux-arm64']), contract([...current, 'linux-arm64']), contract([...current.slice(0, 3), 'win32-x64']),
      JSON.stringify({ schema: 'paperclip.runner.release-targets.v1', targets: current, host: 'trusted-fleet' }),
      JSON.stringify({ schema: 'other', targets: current }), contract('linux-arm64'), 'null', '{invalid', ' '.repeat(65 * 1024),
    ]) {
      const result = run(pin(`export const RELEASE_RUNNER_TARGETS = ${JSON.stringify(historical)};`, data));
      assert.notEqual(result.status, 0, 'Malformed present data must never fall back to a legacy module');
      assert.equal(readFileSync(output, 'utf8'), '');
    }
    for (const module of [malicious,
      'export const RELEASE_RUNNER_TARGETS = getTargets();',
      `export const RELEASE_RUNNER_TARGETS = ${JSON.stringify(current)};\nexport const RELEASE_RUNNER_TARGETS = ${JSON.stringify(historical)};`,
      'export const RELEASE_RUNNER_TARGETS = ["linux-arm64"];']) {
      const result = run(pin(module, undefined));
      assert.notEqual(result.status, 0, 'Unknown legacy declarations must fail closed');
      assert.equal(readFileSync(output, 'utf8'), '');
    }
    pin(malicious, undefined);
    symlinkSync('scripts/stage-release-runner-binaries.mjs', dataFile);
    git(['add', 'packages']);
    git(['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Symlink fixture']);
    assert.notEqual(run(git(['rev-parse', 'HEAD'])).status, 0, 'Source contract symlinks must not be followed');
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("historical promotion sources keep their packaging path while new sources require daemon assembly", () => {
  const workflow = readWorkflow("release.yml");
  const selector = workflow.split('      - name: Read the exact source packaging contract')[1].split('\n  release_runner_binaries:')[0];
  const script = selector.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const root = mkdtempSync(path.join(tmpdir(), 'release-source-contract-'));
  try {
    const tools = path.join(root, 'tools'); mkdirSync(tools);
    writeFileSync(path.join(tools, 'git'), '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s\\n" "$FIXTURE_HEAD";;\nshow) cat "$FIXTURE_SOURCE";;\n*) exit 3;;\nesac\n', { mode: 0o755 });
    const source = path.join(root, 'release.sh'), output = path.join(root, 'outputs');
    for (const [contents, required] of [['pnpm build\n', false], ['assemble-daemons "$PAPERCLIP_RELEASE_RUNNER_ARTIFACTS_DIR" "$SOURCE_SHA"\n', true]]) {
      writeFileSync(source, contents); writeFileSync(output, '');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
        PATH: `${tools}:/usr/bin:/bin`, SOURCE_SHA: 'a'.repeat(40), FIXTURE_HEAD: 'a'.repeat(40), FIXTURE_SOURCE: source, GITHUB_OUTPUT: output,
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(output, 'utf8'), new RegExp(`required=${required}`));
    }
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
      PATH: `${tools}:/usr/bin:/bin`, SOURCE_SHA: 'a'.repeat(40), FIXTURE_HEAD: 'b'.repeat(40), FIXTURE_SOURCE: source, GITHUB_OUTPUT: output,
    } });
    assert.equal(result.status, 1, 'Wrong checkout cannot opt out of mandatory assembly');
    const unreadable = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
      PATH: `${tools}:/usr/bin:/bin`, SOURCE_SHA: 'a'.repeat(40), FIXTURE_HEAD: 'a'.repeat(40), FIXTURE_SOURCE: path.join(root, 'absent'), GITHUB_OUTPUT: output,
    } });
    assert.equal(unreadable.status, 1, 'A failed immutable source read must not masquerade as a legacy source');

  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const job of ['publish_canary','publish_nightly','publish_beta','preview_stable','publish_stable']) {
    const block = workflow.split(`  ${job}:\n`)[1].split(/\n  [a-z_]+:\n/)[0];
    assert.match(block, /needs.release_runner_source.result == 'success'/);
    assert.match(block, /needs.release_runner_source.outputs.required == 'false' \|\| needs.release_runner_binaries.result == 'success'/);
    assert.match(block, /Download exact-source release daemon receipts\n\s+if: needs.release_runner_source.outputs.required == 'true'/);
  }
});



test("canary startup refreshes an incomplete dependency publication, then onboards once", async () => {
  const result = await canaryStartup({ mode: "recover" });
  assert.equal(result.code, 0, result.output);
  const installs = result.calls.filter(call => call.kind === "npm");
  const onboarding = result.calls.filter(call => call.kind === "onboard");
  assert.equal(installs.length, 2);
  assert.equal(onboarding.length, 1);
  for (const call of installs) {
    assert.equal(call.args[0], "install");
    assert.ok(call.args.includes("paperclipai@2026.1009.0-canary.1"));
    assert.ok(call.args.includes("--no-package-lock"));
    assert.ok(call.args.includes("--no-save"));
  }
  assert.ok(!installs[0].args.includes("--prefer-online"));
  assert.ok(installs[1].args.includes("--prefer-online"));
  assert.notEqual(installs[0].args[2], installs[1].args[2]);
  assert.equal(installs[0].cache, installs[1].cache);
  assert.deepEqual(onboarding[0].args.slice(0, 3), ["onboard", "--yes", "--data-dir"]);
});

test("permanent missing versions stop after three attempts without onboarding", async () => {
  const result = await canaryStartup({ mode: "permanent" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter(call => call.kind === "npm").length, 3);
  assert.equal(result.calls.filter(call => call.kind === "onboard").length, 0);
  assert.match(result.output, /installation failed.*onboarding was not started/);
});

test("npm failures other than ETARGET fail immediately without onboarding", async () => {
  const result = await canaryStartup({ mode: "auth" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.match(result.output, /E401/);
});

test("onboarding failures are never retried, even when they mention ETARGET", async () => {
  const result = await canaryStartup({ mode: "success", onboard: "fail" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter(call => call.kind === "npm").length, 1);
  assert.equal(result.calls.filter(call => call.kind === "onboard").length, 1);
  assert.match(result.output, /onboarding failed \(exit 17\)/);
});

test("a hanging npm install is stopped within the shared acquisition budget", async () => {
  const result = await canaryStartup({ mode: "hang", budget: 1000 });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter(call => call.kind === "npm").length, 1);
  assert.equal(result.calls.filter(call => call.kind === "onboard").length, 0);
  assert.ok(result.elapsed < 4000, `install exceeded bounded cancellation: ${result.elapsed}ms`);
  assert.match(result.output, /exceeded its startup budget/);
});

test("backoff consumes the shared budget and does not begin another install after expiry", async () => {
  const result = await canaryStartup({ mode: "permanent", budget: 1000, delay: 5000 });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.match(result.output, /exceeded its startup budget/);
});


test("Playwright cancellation stops an onboarding process without replay", async () => {
  const result = await canaryStartup({ mode: "success", onboard: "hang", cancelAtKind: "onboard" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter(call => call.kind === "npm").length, 1);
  const onboarding = result.calls.filter(call => call.kind === "onboard");
  assert.equal(onboarding.length, 1);
  assert.throws(() => process.kill(onboarding[0].pid, 0), {code:"ESRCH"});
  assert.match(result.output, /stopped by SIGTERM/);
  assert.ok(result.elapsed < 2500, `onboarding cancellation took ${result.elapsed}ms`);
});

test("canary install retries retain the existing overall Playwright startup deadline", async () => {
  const { INSTALL_BUDGET_MS } = await import("../../tests/canary-onboarding/start-published-canary.mjs");
  const config = readFileSync(path.join(repoRoot, "tests/canary-onboarding/playwright.config.ts"), "utf8");
  assert.equal(INSTALL_BUDGET_MS, 120_000);
  assert.match(config, /timeout: 300_000/);
  assert.match(config, /start-published-canary\.mjs/);
  assert.match(config, /reuseExistingServer: false/);
});


test("nested ETARGET output does not retry a final authentication or network failure", async () => {
  for (const mode of ["mixed", "network"]) {
    const result = await canaryStartup({ mode });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
  }
});

const exactCanary = "2026.1009.0-canary.1";
const canaryTarball = `https://registry.npmjs.org/@paperclipai/server/-/server-${exactCanary}.tgz`;
const tarballFailure = (url = canaryTarball, prefix = "npm error") => `${prefix} code E404\n${prefix} 404 Not Found - GET ${url} - Not found\n${prefix} 404\n${prefix} 404  The requested resource '@paperclipai/server@${url}' could not be found or you do not have permission to access it.\n`;

function tarballProof({ config = {}, manifest = {}, status = 200, redirected = false, responseUrl, rawBody } = {}) {
  const calls = [];
  const dist = { tarball: canaryTarball, integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, ...manifest.dist };
  const data = { name: "@paperclipai/server", version: exactCanary, ...manifest, dist };
  return { calls, options: {
    signal: new AbortController().signal, prefix: "/fixture/install", env: {},
    runConfig: async (command, args, options) => {
      calls.push({ kind: "config", command, args, options });
      return { code: 0, stdout: "registry=https://registry.npmjs.org/\n@paperclipai:registry=undefined\n", ...config };
    },
    fetchMetadata: async (url, options) => {
      calls.push({ kind: "metadata", url, options });
      return { status, redirected, url: responseUrl ?? url, body: new Response(rawBody ?? JSON.stringify(data)).body };
    },
  } };
}

test("exact published tarball proof uses quiet effective config and fresh public metadata without credentials", async () => {
  for (const prefix of ["npm error", "npm ERR!"]) {
    const fixture = tarballProof();
    assert.equal(await canRetryPublishedTarball404(tarballFailure(canaryTarball, prefix), exactCanary, fixture.options), true);
    const [config, metadata] = fixture.calls;
    assert.deepEqual(config.args, ["config", "get", "registry", "@paperclipai:registry", "--prefix", "/fixture/install"]);
    assert.equal(config.options.env, fixture.options.env);
    assert.equal(config.options.quiet, true);
    assert.equal(config.options.captureStdout, true);
    assert.equal(config.options.captureStderr, true);
    assert.equal(config.options.outputLimit, 4096);
    assert.equal(metadata.url, `https://registry.npmjs.org/%40paperclipai%2Fserver/${exactCanary}`);
    assert.equal(metadata.options.signal, config.options.signal);
    assert.equal(metadata.options.redirect, "error");
    assert.equal(metadata.options.credentials, "omit");
    assert.deepEqual(metadata.options.headers, { accept: "application/json", "cache-control": "no-cache" });
  }
});

test("mixed npm errors and noncanonical or unreleased tarballs never read config or metadata", async () => {
  const errors = [
    "npm error code ETARGET\n", "npm error code E401\n", "npm error code ECONNRESET\n",
    `${tarballFailure()}npm error code E401\n`, `${tarballFailure()}npm error code 1\n`,
    `npm error code ENEEDAUTH\n${tarballFailure()}`, `${tarballFailure()}${tarballFailure()}`,
    `${tarballFailure()}npm error 404 Not Found - GET https://registry.example.invalid/a.tgz - Not found\n`,
    `${tarballFailure()}npm error 404 The requested resource 'other@${canaryTarball}' could not be found\n`,
    tarballFailure().replace(" - GET ", " - PUT "),
    ...[
      canaryTarball + "?token=fixture", canaryTarball + "#fragment", canaryTarball.replace("npmjs.org/", "npmjs.org:443/"),
      canaryTarball.replace("npmjs.org/", "npmjs.org.example.invalid/"), canaryTarball.replace("npmjs.org/", "fixture@npmjs.org/"),
      canaryTarball.replace("https:", "http:"), canaryTarball.replace("@paperclipai/server", "%40paperclipai%2Fserver"),
      canaryTarball.replace("@paperclipai/server", "@paperclipai/../server"), canaryTarball.replace(exactCanary, "2026.1009.0-canary.2"),
      "https://registry.npmjs.org/@paperclipai/not-released/-/not-released-2026.1009.0-canary.1.tgz",
      "https://registry.npmjs.org/@paperclipai/plugin-createos/-/plugin-createos-2026.1009.0-canary.1.tgz",
      "https://registry.npmjs.org/%40paperclipai%2Fserver/2026.1009.0-canary.1",
    ].map((url) => tarballFailure(url)),
  ];
  for (const error of errors) {
    const fixture = tarballProof();
    assert.equal(await canRetryPublishedTarball404(error, exactCanary, fixture.options), false, error);
    assert.deepEqual(fixture.calls, [], error);
  }
  for (const version of ["2026.1009.0", "2026.1009.0-nightly.1", "2026.1009.0-beta.1", "2026.1009.0-canary.1+build"]) {
    const fixture = tarballProof();
    assert.equal(await canRetryPublishedTarball404(tarballFailure(canaryTarball.replace(exactCanary, version)), version, fixture.options), false);
    assert.deepEqual(fixture.calls, []);
  }
});

test("effective registry authority respects scope precedence and rejects unknown or private config", async () => {
  const configs = [
    [{ stdout: "registry=https://registry.example.invalid/\n@paperclipai:registry=https://registry.npmjs.org/\n" }, true],
    [{ stdout: "registry=undefined\n@paperclipai:registry=https://registry.npmjs.org/\n" }, true],
    [{ stdout: "registry=https://registry.npmjs.org/\n@paperclipai:registry=https://registry.example.invalid/\n" }, false],
    [{ stdout: "registry=https://registry.example.invalid/\n@paperclipai:registry=undefined\n" }, false],
    [{ stdout: "registry=undefined\n@paperclipai:registry=undefined\n" }, false],
    [{ stdout: "registry=https://registry.npmjs.org/\n@paperclipai:registry=\n" }, false],
    [{ stdout: "registry=https://fixture:secret@registry.npmjs.org/\n@paperclipai:registry=undefined\n" }, false],
    [{ stdout: "unexpected output\n" }, false], [{ code: 1 }, false], [{ signal: "SIGTERM" }, false], [{ outputTruncated: true }, false],
  ];
  for (const [config, expected] of configs) {
    const fixture = tarballProof({ config });
    assert.equal(await canRetryPublishedTarball404(tarballFailure(), exactCanary, fixture.options), expected);
    assert.equal(fixture.calls.filter((call) => call.kind === "metadata").length, expected ? 1 : 0);
  }
});

test("metadata must identify the exact published artifact with valid SHA512 syntax, not merely exist", async () => {
  const fixtures = [
    { status: 404 }, { status: 401 }, { status: 403 }, { status: 302 }, { redirected: true },
    { responseUrl: "https://registry.example.invalid/metadata" }, { rawBody: "not json" },
    { manifest: { name: "@paperclipai/shared" } }, { manifest: { version: "2026.1009.0-canary.2" } },
    { manifest: { dist: { tarball: canaryTarball + "?query=1" } } },
    ...[undefined, "", "sha512-A===", `sha256-${Buffer.alloc(32).toString("base64")}`, `sha512-${Buffer.alloc(64).toString("base64")} extra`]
      .map((integrity) => ({ manifest: { dist: { integrity } } })),
    { rawBody: JSON.stringify({ padding: "x".repeat(65 * 1024) }) },
  ];
  for (const input of fixtures) {
    const fixture = tarballProof(input);
    assert.equal(await canRetryPublishedTarball404(tarballFailure(), exactCanary, fixture.options), false, JSON.stringify(input).slice(0, 200));
  }
});

test("rejected and oversized native response bodies cancel without waiting for slow or rejected cleanup", async () => {
  for (const [status, pending] of [[200, true], [200, false], [404, true], [404, false]]) {
    let cancelled = false;
    const fixture = tarballProof();
    fixture.options.fetchMetadata = async (url) => ({ status, redirected: false, url, body: new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); },
      cancel() { cancelled = true; return pending ? new Promise(() => {}) : Promise.reject(new Error("fixture rejected cancellation")); },
    })).body });
    const started = Date.now();
    assert.equal(await canRetryPublishedTarball404(tarballFailure(), exactCanary, fixture.options), false);
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started < 1000, "cancellation acknowledgement must not extend a rejection");
  }
});

test("aborting a stalled metadata read cancels its reader without waiting for acknowledgement", { timeout: 2000 }, async () => {
  let cancelled = false;
  const fixture = tarballProof();
  fixture.options.fetchMetadata = async (url) => ({ status: 200, redirected: false, url,
    body: new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise(() => {}); },
    })).body });
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error("fixture body budget expired")), 100);
  const started = Date.now();
  try {
    await assert.rejects(canRetryPublishedTarball404(tarballFailure(), exactCanary, {
      ...fixture.options, signal: budget.signal,
    }), /fixture body budget expired/);
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started < 1000);
  } finally { clearTimeout(timer); }
});

test("metadata headers cannot outlive the budget and late response bodies are cancelled", { timeout: 2000 }, async () => {
  let headersArrive;
  let cancelled = false;
  const fixture = tarballProof();
  fixture.options.fetchMetadata = (url) => new Promise((resolve) => {
    headersArrive = () => resolve({ status: 200, redirected: false, url,
      body: new Response(new ReadableStream({ cancel() { cancelled = true; } })).body });
  });
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error("fixture headers budget expired")), 100);
  const started = Date.now();
  try {
    await assert.rejects(canRetryPublishedTarball404(tarballFailure(), exactCanary, {
      ...fixture.options, signal: budget.signal,
    }), /fixture headers budget expired/);
    assert.ok(Date.now() - started < 1000);
    headersArrive();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test("real npm effective registry reads isolated prefix, user, and environment configuration", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "canary-config-proof-"));
  mkdirSync(path.join(root, "prefix"));
  writeFileSync(path.join(root, "global.npmrc"), "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
  env.npm_config_userconfig = path.join(root, "user.npmrc");
  env.npm_config_globalconfig = path.join(root, "global.npmrc");
  try {
    for (const [user, project, override, expected] of [
      ["registry=https://registry.npmjs.org/\n", "", undefined, true],
      ["registry=https://registry.example.invalid/\n", "@paperclipai:registry=https://registry.npmjs.org/\n", undefined, true],
      ["registry=https://registry.npmjs.org/\n", "@paperclipai:registry=https://registry.example.invalid/\n", undefined, false],
      ["registry=https://registry.npmjs.org/\n", "", "https://registry.example.invalid/", false],
    ]) {
      writeFileSync(path.join(root, "user.npmrc"), user);
      writeFileSync(path.join(root, "prefix", ".npmrc"), project);
      const fixture = tarballProof();
      delete fixture.options.runConfig;
      assert.equal(await canRetryPublishedTarball404(tarballFailure(), exactCanary, {
        ...fixture.options, prefix: path.join(root, "prefix"), env: { ...env, ...(override ? { npm_config_registry: override } : {}) },
      }), expected);
      assert.equal(fixture.calls.length, expected ? 1 : 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function stalledMetadata(run) {
  let closed = false;
  let closing = false;
  let observeClose;
  const connectionClosed = new Promise((resolve) => { observeClose = resolve; });
  const server = createServer((_request, response) => {
    response.on("close", () => { closed = true; observeClose(); });
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"name":');
  });
  // An HTTP client can replace an aborted pooled connection while shutdown
  // starts. Own late connections too, so server.close cannot wait on them.
  server.on("connection", (socket) => { if (closing) socket.destroy(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = tarballProof();
  fixture.options.fetchMetadata = async (url, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/metadata`, options);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  let closeDeadline;
  try {
    await run(fixture.options);
    await Promise.race([connectionClosed, new Promise((_, reject) => {
      closeDeadline = setTimeout(() => reject(new Error("metadata connection outlived cancellation")), 1000);
    })]);
    assert.equal(closed, true, "metadata connection must close before fixture-forced cleanup");
  }
  finally {
    clearTimeout(closeDeadline);
    closing = true;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

test("shared acquisition cancellation aborts the metadata body before the lookup deadline", async () => {
  await stalledMetadata(async (options) => {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error("fixture shared budget expired")), 250);
    try {
      await assert.rejects(canRetryPublishedTarball404(tarballFailure(), exactCanary, { ...options, signal: budget.signal }), /fixture shared budget expired/);
    } finally { clearTimeout(timer); }
  });
});

test("the short config and metadata deadline also covers a stalled real HTTP body", { timeout: 10_000 }, async () => {
  assert.equal(TARBALL_METADATA_TIMEOUT_MS, 5000);
  const started = Date.now();
  await stalledMetadata(async (options) => {
    assert.equal(await canRetryPublishedTarball404(tarballFailure(), exactCanary, options), false);
  });
  assert.ok(Date.now() - started < 7000, "metadata must not consume the 120s acquisition budget");
});

test("a verified canary tarball404 retries acquisition and runs onboarding once", async () => {
  const result = await canaryStartup({ mode: "tarball-recover" });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.calls.filter((call) => call.kind === "npm").length, 2);
  assert.equal(result.calls.filter((call) => call.kind === "config").length, 1);
  assert.equal(result.calls.filter((call) => call.kind === "metadata").length, 1);
  assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 1);
  assert.doesNotMatch(result.output, /fixture config diagnostic/);
});

test("persistent promised tarball404s stop at three installs without a final lookup or onboarding", async () => {
  const result = await canaryStartup({ mode: "tarball-permanent" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter((call) => call.kind === "npm").length, 3);
  assert.equal(result.calls.filter((call) => call.kind === "config").length, 2);
  assert.equal(result.calls.filter((call) => call.kind === "metadata").length, 2);
  assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 0);
  assert.match(result.output, /installation failed.*onboarding was not started/);
});

test("private or oversized config and unpublished metadata404 fail without retry or leaking config", async () => {
  for (const input of [{ config: "private" }, { config: "large" }, { metadata: "missing" }]) {
    const result = await canaryStartup({ mode: "tarball-permanent", ...input });
    assert.equal(result.code, 1);
    assert.equal(result.calls.filter((call) => call.kind === "npm").length, 1);
    assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 0);
    assert.doesNotMatch(result.output, /fixture-user|fixture-password|fixture config diagnostic/);
  }
});

test("truncated npm output cannot hide an earlier auth failure and qualify a tarball retry", async () => {
  const result = await canaryStartup({ mode: "tarball-large" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter((call) => call.kind === "npm").length, 1);
  assert.equal(result.calls.filter((call) => call.kind === "config").length, 0);
  assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 0);
});

test("tarball recovery does not replay onboarding failures or change ETARGET for other exact versions", async () => {
  const failed = await canaryStartup({ mode: "tarball-recover", onboard: "fail" });
  assert.equal(failed.code, 1);
  assert.equal(failed.calls.filter((call) => call.kind === "npm").length, 2);
  assert.equal(failed.calls.filter((call) => call.kind === "onboard").length, 1);
  assert.match(failed.output, /onboarding failed \(exit 17\)/);
  const other = await canaryStartup({ mode: "recover", version: "2026.1009.0-nightly.1" });
  assert.equal(other.code, 0, other.output);
  assert.equal(other.calls.filter((call) => call.kind === "npm").length, 2);
  assert.equal(other.calls.filter((call) => call.kind === "onboard").length, 1);
  assert.equal(other.calls.filter((call) => call.kind === "config").length, 0);
});

test("existing ETARGET character-tail behavior survives long multibyte npm diagnostics", async () => {
  const result = await canaryStartup({ mode: "multibyte-recover" });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.calls.filter((call) => call.kind === "npm").length, 2);
  assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 1);
  assert.equal(result.calls.filter((call) => call.kind === "config").length, 0);
});

test("metadata lookup and backoff both consume the unchanged shared acquisition budget", async () => {
  for (const input of [{ metadata: "hang" }, { delay: 5000 }]) {
    const result = await canaryStartup({ mode: "tarball-permanent", budget: 1000, ...input });
    assert.equal(result.code, 1);
    assert.equal(result.calls.filter((call) => call.kind === "npm").length, 1);
    assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 0);
    assert.match(result.output, /exceeded its startup budget/);
    assert.ok(result.elapsed < 4000, `shared-budget cancellation took ${result.elapsed}ms`);
  }
});

test("cancellation reaps a config process and its descendant that ignore SIGTERM", async () => {
  const result = await canaryStartup({ mode: "tarball-permanent", config: "hang", cancelAtKind: "config-descendant" });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter((call) => call.kind === "npm").length, 1);
  assert.equal(result.calls.filter((call) => call.kind === "onboard").length, 0);
  for (const child of result.calls.filter((call) => ["config", "config-descendant"].includes(call.kind))) {
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  }
  assert.match(result.output, /stopped by SIGTERM/);
});
