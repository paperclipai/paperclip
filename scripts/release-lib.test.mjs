import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function workflowVerifyBudget() {
  return {
    verifyAttempts: Number(releaseWorkflow.match(/^  NPM_PUBLISH_VERIFY_ATTEMPTS: "(\d+)"$/m)?.[1]),
    verifyDelaySeconds: Number(releaseWorkflow.match(/^  NPM_PUBLISH_VERIFY_DELAY_SECONDS: "(\d+)"$/m)?.[1]),
  };
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function runPublishHelper({
  pnpmMode,
  npmVersionExists = false,
  distTag = "canary",
  callerPipefail = true,
  publishTool = "pnpm",
  waitForRegistry = false,
  npmVersionExistsAfterChecks = 0,
  verifyAttempts = 1,
  verifyDelaySeconds = 0,
  visibilityPackages = null,
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-lib-"));
  const binDir = join(fixtureDir, "bin");
  const stateDir = join(fixtureDir, "state");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  writeFileSync(callLog, "");

  writeExecutable(
    join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$PNPM_MODE" in
  success)
    echo "published"
    exit 0
    ;;
  tlog-then-success)
    if [ ! -f "$FAKE_STATE_DIR/pnpm-called" ]; then
      touch "$FAKE_STATE_DIR/pnpm-called"
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
    fi
    case " $* " in
      *" --provenance=false "*)
        echo "published without provenance"
        exit 0
        ;;
      *)
        echo "retry did not disable provenance"
        exit 1
        ;;
    esac
    ;;
  tlog-always-fails)
    echo "npm error code TLOG_CREATE_ENTRY_ERROR"
    echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
    exit 1
    ;;
  non-tlog-failure)
    echo "npm error code E500"
    exit 1
    ;;
esac
exit 1
`,
  );

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [ "$1" = "view" ]; then
  if [ "\${NPM_VIEW_CROSS:-}" = "true" ]; then
    # Cross-visibility mode: a package resolves only after every OTHER
    # package has been polled at least once. Mutually dependent visibility
    # can only converge when the polls run concurrently.
    spec="$2"
    name="\${spec%@*}"
    safe="$(printf '%s' "$name" | tr '/@' '__')"
    touch "$FAKE_STATE_DIR/seen-$safe"
    all_seen=true
    for other in $CROSS_PACKAGES; do
      osafe="$(printf '%s' "$other" | tr '/@' '__')"
      [ "$osafe" = "$safe" ] && continue
      [ -f "$FAKE_STATE_DIR/seen-$osafe" ] || all_seen=false
    done
    if [ "$all_seen" = "true" ]; then
      echo "1.2.3"
      exit 0
    fi
    exit 1
  fi
  checks=0
  if [ -f "$FAKE_STATE_DIR/view-checks" ]; then
    read -r checks < "$FAKE_STATE_DIR/view-checks"
  fi
  checks=$((checks + 1))
  echo "$checks" > "$FAKE_STATE_DIR/view-checks"
  if [ "$NPM_VERSION_EXISTS" = "true" ] ||
    { [ "$NPM_VERSION_EXISTS_AFTER_CHECKS" -gt 0 ] && [ "$checks" -ge "$NPM_VERSION_EXISTS_AFTER_CHECKS" ]; }; then
    echo "1.2.3"
    exit 0
  fi
fi
if [ "$1" = "publish" ]; then
  case "$PNPM_MODE" in
    success)
      echo "published"
      exit 0
      ;;
    tlog-then-success)
      if [ ! -f "$FAKE_STATE_DIR/npm-called" ]; then
        touch "$FAKE_STATE_DIR/npm-called"
        echo "npm error code TLOG_CREATE_ENTRY_ERROR"
        echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
        exit 1
      fi
      case " $* " in
        *" --provenance=false "*)
          echo "published without provenance"
          exit 0
          ;;
      esac
      ;;
    tlog-always-fails)
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
      ;;
    non-tlog-failure)
      echo "npm error code E500"
      exit 1
      ;;
  esac
fi
exit 1
`,
  );

  writeExecutable(
    join(binDir, "npx"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "$FAKE_CALL_LOG"
[ "$1" = "--yes" ] && shift
case "$1" in
  npm@10.9.7|npm@11.18.0) shift ;;
esac
exec npm "$@"
`,
  );

  const shellOptions = callerPipefail ? "set -euo pipefail" : "set -eu";
  // The cross-visibility concurrency test needs real (fractional-second)
  // sleeps so slower-starting sibling polls get a chance to run; every other
  // test records virtual waiting so registry-delay tests stay fast/offline.
  const sleepStub = visibilityPackages
    ? ""
    : `sleep() { printf 'sleep %s\\n' "$*" >> "$FAKE_CALL_LOG"; }`;
  const packageInfo = (
    visibilityPackages ?? ["@paperclipai/example"]
  )
    .map((name) => `packages/example\\t${name}\\t1.2.3`)
    .join("\\n");
  const script = `
${shellOptions}
source "${repoRoot}/scripts/release-lib.sh"
${sleepStub}
${
  visibilityPackages
    ? `PACKAGE_INFO="$(printf '${packageInfo}')"
wait_for_npm_package_versions "$VERIFY_ATTEMPTS" "$VERIFY_DELAY_SECONDS" "$PACKAGE_INFO"`
    : waitForRegistry
      ? `publish_package_to_npm ${distTag} @paperclipai/example 1.2.3 ${publishTool}
PACKAGE_INFO="$(printf '${packageInfo}')"
wait_for_npm_package_versions "$VERIFY_ATTEMPTS" "$VERIFY_DELAY_SECONDS" "$PACKAGE_INFO"`
      : `publish_package_to_npm ${distTag} @paperclipai/example 1.2.3 ${publishTool}`
}
`;

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", ["-c", script], {
      cwd: fixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        FAKE_STATE_DIR: stateDir,
        NPM_VERSION_EXISTS: npmVersionExists ? "true" : "false",
        NPM_VERSION_EXISTS_AFTER_CHECKS: String(npmVersionExistsAfterChecks),
        VERIFY_ATTEMPTS: String(verifyAttempts),
        VERIFY_DELAY_SECONDS: String(verifyDelaySeconds),
        NPM_VIEW_CROSS: visibilityPackages ? "true" : "false",
        CROSS_PACKAGES: (visibilityPackages ?? []).join(" "),
        PNPM_MODE: pnpmMode,
        REPO_ROOT: fixtureDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  return {
    calls: readFileSync(callLog, "utf8"),
    output,
    status,
  };
}

test("publish_package_to_npm returns after a successful pnpm publish", () => {
  const result = runPublishHelper({ pnpmMode: "success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm uses trusted publishing from the bundled staging directory", () => {
  const result = runPublishHelper({ pnpmMode: "success", publishTool: "npm" });

  assert.equal(result.status, 0);
  assert.match(
    result.calls,
    /^npx --yes npm@11\.18\.0 publish --tag canary --access public --ignore-scripts --loglevel verbose$/m,
  );
  assert.match(
    result.calls,
    /^npm publish --tag canary --access public --ignore-scripts --loglevel verbose$/m,
  );
  assert.doesNotMatch(result.calls, / pack /);
  assert.doesNotMatch(result.calls, /^pnpm publish/m);
});

test("publish_package_to_npm retries bundled directory tlog failures without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success", publishTool: "npm" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^npm publish --tag canary --access public --provenance=false --ignore-scripts --loglevel verbose$/m,
  );
});

test("publish_package_to_npm retries duplicate tlog failures without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^pnpm publish --no-git-checks --tag canary --access public --provenance=false$/m,
  );
});

test("publish_package_to_npm treats a duplicate tlog failure as complete when npm exposes the version", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-always-fails", npmVersionExists: true });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry unrelated publish failures", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure" });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not mask failures when caller has no pipefail", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure", callerPipefail: false });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry stable publishes without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success", distTag: "latest" });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("wait_for_npm_package_versions confirms registry visibility after a publish", () => {
  const result = runPublishHelper({
    pnpmMode: "success",
    npmVersionExists: true,
    waitForRegistry: true,
  });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
});

test("wait_for_npm_package_versions blocks the release and names the straggler", () => {
  const result = runPublishHelper({ pnpmMode: "success", waitForRegistry: true });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(result.output, /did not become registry-visible: @paperclipai\/example@1\.2\.3/);
});

test("wait_for_npm_package_versions polls every package concurrently", () => {
  // In cross-visibility mode each fake package resolves only after the OTHER
  // package has been polled at least once. Waiting out one package's full
  // budget before polling the next can never satisfy the first package;
  // only concurrent polling converges.
  const result = runPublishHelper({
    pnpmMode: "success",
    visibilityPackages: ["@paperclipai/alpha", "@paperclipai/beta"],
    verifyAttempts: 50,
    verifyDelaySeconds: 0.2,
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /@paperclipai\/alpha@1\.2\.3 is registry-visible/);
  assert.match(result.output, /@paperclipai\/beta@1\.2\.3 is registry-visible/);
});

test("the workflow budget tolerates the observed 15-minute 20-second registry delay", () => {
  const budget = workflowVerifyBudget();
  assert.ok(budget.verifyDelaySeconds > 0);
  const delayedCheck = Math.ceil((15 * 60 + 20) / budget.verifyDelaySeconds) + 1;
  const result = runPublishHelper({
    pnpmMode: "success",
    waitForRegistry: true,
    npmVersionExistsAfterChecks: delayedCheck,
    ...budget,
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.match(/^pnpm publish /gm)?.length, 1);
  assert.equal(result.calls.match(/^npm view /gm)?.length, delayedCheck);
  assert.deepEqual(
    result.calls.split("\n").filter((call) => call.startsWith("sleep ")),
    Array(delayedCheck - 1).fill(`sleep ${budget.verifyDelaySeconds}`),
  );
});

test("the workflow budget does not delay an immediately visible publish", () => {
  const result = runPublishHelper({
    pnpmMode: "success",
    npmVersionExists: true,
    waitForRegistry: true,
    ...workflowVerifyBudget(),
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.match(/^npm view /gm)?.length, 1);
  assert.doesNotMatch(result.calls, /^sleep /m);
});

test("the workflow budget fails closed after the last registry check", () => {
  const budget = workflowVerifyBudget();
  assert.ok(budget.verifyAttempts > 0);
  const result = runPublishHelper({
    pnpmMode: "success",
    waitForRegistry: true,
    npmVersionExistsAfterChecks: budget.verifyAttempts + 1,
    ...budget,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.output, /did not become registry-visible/);
  assert.equal(result.calls.match(/^pnpm publish /gm)?.length, 1);
  assert.equal(result.calls.match(/^npm view /gm)?.length, budget.verifyAttempts);
  assert.equal(result.calls.match(/^sleep /gm)?.length, budget.verifyAttempts - 1);
});

test("every publish job budgets for build time, four delayed packages and the install deadline", () => {
  const { verifyAttempts, verifyDelaySeconds } = workflowVerifyBudget();
  const pollingSeconds = (verifyAttempts - 1) * verifyDelaySeconds;
  const releaseScript = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
  const installDeadlineSeconds = Number(releaseScript.match(/NPM_INSTALL_VERIFY_TIMEOUT_SECONDS:-(\d+)/)?.[1]);
  assert.ok(installDeadlineSeconds > 0);

  for (const [job, requiredSeconds] of [
    ["publish_canary", 30 * 60 + 4 * pollingSeconds],
    ["publish_nightly", 30 * 60 + 4 * pollingSeconds + installDeadlineSeconds],
    ["publish_beta", 30 * 60 + 4 * pollingSeconds + installDeadlineSeconds],
    ["publish_stable", 30 * 60 + 4 * pollingSeconds + installDeadlineSeconds],
  ]) {
    const body = releaseWorkflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0] ?? "";
    const timeoutMinutes = Number(body.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(timeoutMinutes * 60 > requiredSeconds, `${job} must leave time beyond build, polling and the install deadline`);
  }
});

function canaryNumberFixture({ commits, publishedVersions, shallow = false }) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-canary-number-"));
  const source = join(dir, "source");
  mkdirSync(source);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  git(source, "init", "-q", "-b", "master");
  for (let index = 0; index < commits; index += 1) git(source, "commit", "-q", "--allow-empty", "-m", `c${index}`);
  let repo = source;
  if (shallow) {
    repo = join(dir, "shallow");
    git(dir, "clone", "-q", "--depth", "1", `file://${source}`, repo);
  }
  const versionsFile = join(dir, "versions.json");
  writeFileSync(versionsFile, JSON.stringify({ "@paperclipai/shared": publishedVersions, paperclipai: publishedVersions }));
  return { dir, repo, versionsFile, git };
}

function nextCanary(fixture, { allowFallback = false, attempt = "1" } = {}) {
  const script = `source "${repoRoot}/scripts/release-lib.sh"; next_canary_version_from_source "$1" "$2" 2026.1116.0 "$3" @paperclipai/shared paperclipai`;
  return execFileSync("bash", ["-c", script, "next-canary", fixture.repo, String(allowFallback), attempt], {
    encoding: "utf8", env: { ...process.env, RELEASE_PACKAGE_VERSIONS_FILE: fixture.versionsFile }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("a canary is numbered from its master position and run attempt, ignoring other commits' numbers", () => {
  const fixture = canaryNumberFixture({ commits: 25, publishedVersions: ["2026.1116.0-canary.2600", "2026.1116.0-canary.9999"] });
  assert.equal(nextCanary(fixture), "2026.1116.0-canary.2500");
  assert.equal(nextCanary(fixture, { attempt: "2" }), "2026.1116.0-canary.2501");
  assert.equal(nextCanary(fixture, { attempt: "99" }), "2026.1116.0-canary.2598");
});

test("publishing the same commit again outside a rerun moves to the next free number in its own range", () => {
  const fixture = canaryNumberFixture({ commits: 25, publishedVersions: ["2026.1116.0-canary.2500", "2026.1116.0-canary.2501", "2026.1116.0-canary.2600", "2026.1115.0-canary.2502"] });
  assert.equal(nextCanary(fixture), "2026.1116.0-canary.2502");
  assert.equal(nextCanary(fixture, { attempt: "3" }), "2026.1116.0-canary.2502");
  assert.equal(nextCanary(fixture, { attempt: "4" }), "2026.1116.0-canary.2503");
  const full = canaryNumberFixture({ commits: 25, publishedVersions: Array.from({ length: 100 }, (_, index) => `2026.1116.0-canary.${2500 + index}`) });
  assert.throws(() => nextCanary(full), /every canary number for master position 25 is already published/);
});

test("reruns of one commit never reach the next commit's numbers", () => {
  const earlier = canaryNumberFixture({ commits: 25, publishedVersions: [] });
  const later = canaryNumberFixture({ commits: 26, publishedVersions: [] });
  const earlierNumbers = new Set(Array.from({ length: 99 }, (_, index) => nextCanary(earlier, { attempt: String(index + 1) })));
  assert.equal(earlierNumbers.size, 99);
  assert.equal(earlierNumbers.has(nextCanary(later)), false);
});

test("an invalid run attempt is refused", () => {
  const fixture = canaryNumberFixture({ commits: 3, publishedVersions: [] });
  for (const attempt of ["0", "100", "", "1a"]) assert.throws(() => nextCanary(fixture, { attempt }), /run attempt from 1 to 99/);
});

test("a publishing canary refuses a shallow checkout, and a dry run falls back to the registry number", () => {
  const fixture = canaryNumberFixture({ commits: 5, publishedVersions: ["2026.1116.0-canary.7"], shallow: true });
  assert.throws(() => nextCanary(fixture), /needs the full master history/);
  assert.equal(nextCanary(fixture, { allowFallback: true }), "2026.1116.0-canary.8");
});

test("a canary tag is pushed once, accepted again on the same commit, and refused on another commit", () => {
  const fixture = canaryNumberFixture({ commits: 2, publishedVersions: [] });
  const remote = join(fixture.dir, "remote.git");
  fixture.git(fixture.dir, "init", "-q", "--bare", remote);
  fixture.git(fixture.repo, "remote", "add", "origin", remote);
  const [head, parent] = fixture.git(fixture.repo, "rev-list", "-2", "HEAD").trim().split("\n");
  const pushTag = (sha) => execFileSync("bash", ["-c", `REPO_ROOT="$1"; source "${repoRoot}/scripts/release-lib.sh"; push_release_tag_at origin canary/v2026.1116.0-canary.200 "$2"`, "push-tag", fixture.repo, sha],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(pushTag(head), /Pushed canary\/v2026\.1116\.0-canary\.200/);
  assert.equal(fixture.git(fixture.dir, "--git-dir", remote, "rev-parse", "canary/v2026.1116.0-canary.200").trim(), head);
  assert.match(pushTag(head), /already points at/);
  fixture.git(fixture.repo, "tag", "-d", "canary/v2026.1116.0-canary.200");
  assert.throws(() => pushTag(parent), /already exists on [0-9a-f]{40}, not/);
  assert.equal(fixture.git(fixture.dir, "--git-dir", remote, "rev-parse", "canary/v2026.1116.0-canary.200").trim(), head);
});

test("a canary version is accepted only for the master commit whose position numbered it", () => {
  const fixture = canaryNumberFixture({ commits: 25, publishedVersions: [] });
  const head = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  fixture.git(fixture.repo, "update-ref", "refs/remotes/origin/master", head);
  const confirm = (version, sha) => execFileSync("bash", ["-c", `REPO_ROOT="$1"; source "${repoRoot}/scripts/release-lib.sh"; require_canary_number_from_master_commit "$2" "$3"`, "confirm", fixture.repo, version, sha],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(confirm("2026.1116.0-canary.2500", head), /numbered from .* \(master position 25\)/);
  assert.match(confirm("2026.1116.0-canary.2503", head), /master position 25/);
  assert.throws(() => confirm("2026.1116.0-canary.2600", head), /was not numbered from/);
  assert.throws(() => confirm("2026.1116.0-canary.7", head), /was not numbered from/);
  fixture.git(fixture.repo, "checkout", "-q", "-b", "side");
  fixture.git(fixture.repo, "commit", "-q", "--allow-empty", "-m", "side");
  const side = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  assert.throws(() => confirm("2026.1116.0-canary.2600", side), /is not on origin\/master/);
});

function installRetryFixture({ failures = 0, hangSeconds = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-install-retry-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const counter = join(dir, "attempts");
  writeFileSync(counter, "0");
  writeExecutable(join(bin, "npm"), `#!/usr/bin/env bash
n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
if [ "${hangSeconds}" -gt 0 ]; then sleep "${hangSeconds}"; fi
if [ "$n" -le "${failures}" ]; then echo "npm error code E404" >&2; exit 1; fi
prefix="$3"; mkdir -p "$prefix/node_modules/paperclipai"
printf '{"version":"1.2.3"}' > "$prefix/node_modules/paperclipai/package.json"
`);
  const run = (deadline, delay = 0) => {
    const started = Date.now();
    const result = spawnSync("bash", ["-c", `source "${repoRoot}/scripts/release-lib.sh"; wait_for_npm_installable paperclipai@canary 1.2.3 ${deadline} ${delay}`],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { status: result.status, seconds: (Date.now() - started) / 1000, attempts: Number(readFileSync(counter, "utf8")), stderr: result.stderr };
  };
  return { run };
}

test("a release install is retried while its tarball lags the metadata", () => {
  const recovered = installRetryFixture({ failures: 3 }).run(60);
  assert.equal(recovered.status, 0);
  assert.equal(recovered.attempts, 4);
  assert.match(recovered.stderr, /attempt 3, \d+s left/);
  assert.equal(installRetryFixture({}).run(60).attempts, 1);
});

const hasTimeoutCommand = spawnSync("bash", ["-c", "command -v timeout"], { encoding: "utf8" }).status === 0;

test("install retries stop at the deadline", () => {
  const exhausted = installRetryFixture({ failures: 1000 }).run(3, 1);
  assert.notEqual(exhausted.status, 0);
  assert.ok(exhausted.seconds < 8, `took ${exhausted.seconds}s`);
});

test("an install that hangs is stopped at the deadline", { skip: !hasTimeoutCommand && "needs the timeout command (GNU coreutils)" }, () => {
  const hung = installRetryFixture({ hangSeconds: 120 }).run(3, 1);
  assert.notEqual(hung.status, 0);
  assert.ok(hung.seconds < 20, `a hung install outlived the deadline: ${hung.seconds}s`);
});
