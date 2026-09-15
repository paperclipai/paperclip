import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  const script = `
${shellOptions}
source "${repoRoot}/scripts/release-lib.sh"
# Record virtual waiting so registry-delay tests remain fast and offline.
sleep() { printf 'sleep %s\\n' "$*" >> "$FAKE_CALL_LOG"; }
${
  waitForRegistry
    ? `publish_package_to_npm_and_wait ${distTag} @paperclipai/example 1.2.3 ${publishTool} "$VERIFY_ATTEMPTS" "$VERIFY_DELAY_SECONDS"`
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

test("publish_package_to_npm_and_wait confirms registry visibility before returning", () => {
  const result = runPublishHelper({
    pnpmMode: "success",
    npmVersionExists: true,
    waitForRegistry: true,
  });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
});

test("publish_package_to_npm_and_wait blocks the release when registry visibility lags", () => {
  const result = runPublishHelper({ pnpmMode: "success", waitForRegistry: true });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(result.output, /did not become registry-visible/);
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

test("every publish job budgets for build time and four delayed packages", () => {
  const { verifyAttempts, verifyDelaySeconds } = workflowVerifyBudget();
  const pollingSeconds = (verifyAttempts - 1) * verifyDelaySeconds;
  const requiredSeconds = 30 * 60 + 4 * pollingSeconds;

  for (const job of ["publish_canary", "publish_nightly", "publish_beta", "publish_stable"]) {
    const body = releaseWorkflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0] ?? "";
    const timeoutMinutes = Number(body.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(timeoutMinutes * 60 > requiredSeconds, `${job} must leave time beyond build and polling`);
  }
});
