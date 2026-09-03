import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
if [ "$1" = "view" ] && [ "$NPM_VERSION_EXISTS" = "true" ]; then
  echo "1.2.3"
  exit 0
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
${
  waitForRegistry
    ? `publish_package_to_npm_and_wait ${distTag} @paperclipai/example 1.2.3 ${publishTool} 1 0`
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

function runPreparedLockfileGuard({
  lockfileState = "clean",
  addExtraChange = false,
} = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-lockfile-"));

  execFileSync("git", ["init", "--quiet"], { cwd: fixtureDir });
  writeFileSync(join(fixtureDir, "package.json"), "{}\n");
  writeFileSync(join(fixtureDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], {
    cwd: fixtureDir,
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: fixtureDir },
  );

  if (lockfileState !== "clean") {
    writeFileSync(
      join(fixtureDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nchanged: true\n",
    );
  }
  if (lockfileState === "staged") {
    execFileSync("git", ["add", "pnpm-lock.yaml"], { cwd: fixtureDir });
  }
  if (addExtraChange) {
    writeFileSync(join(fixtureDir, "extra.txt"), "unexpected\n");
  }

  let status = 0;
  let output = "";
  try {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "${repoRoot}/scripts/release-lib.sh"
require_clean_worktree_or_prepared_lockfile`,
      ],
      {
        cwd: fixtureDir,
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: fixtureDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  return { output, status };
}

test("prepared lockfile guard accepts a clean tree or one unstaged lockfile", () => {
  assert.equal(runPreparedLockfileGuard().status, 0);
  assert.equal(
    runPreparedLockfileGuard({ lockfileState: "unstaged" }).status,
    0,
  );
});

test("prepared lockfile guard rejects staged or unrelated changes", () => {
  const staged = runPreparedLockfileGuard({ lockfileState: "staged" });
  const unrelated = runPreparedLockfileGuard({
    lockfileState: "unstaged",
    addExtraChange: true,
  });

  assert.notEqual(staged.status, 0);
  assert.match(
    staged.output,
    /changes other than the prepared pnpm-lock\.yaml/,
  );
  assert.notEqual(unrelated.status, 0);
  assert.match(
    unrelated.output,
    /changes other than the prepared pnpm-lock\.yaml/,
  );
});

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
