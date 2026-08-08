import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function createReleaseFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-dry-run-"));
  const scriptsDir = join(fixtureDir, "scripts");
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(fixtureDir, "releases"));
  mkdirSync(binDir);
  writeFileSync(callLog, "");

  copyFileSync(join(repoRoot, "scripts", "release.sh"), join(scriptsDir, "release.sh"));
  chmodSync(join(scriptsDir, "release.sh"), 0o755);

  writeFileSync(
    join(scriptsDir, "release-lib.sh"),
    `#!/usr/bin/env bash
release_info() { echo "$@"; }
release_fail() { echo "Error: $*" >&2; exit 1; }
resolve_release_remote() { printf 'origin\\n'; }
fetch_release_remote() { :; }
git_current_branch() { printf 'master\\n'; }
get_last_stable_tag() { printf 'v2026.709.0\\n'; }
get_current_stable_version() { printf '2026.709.0\\n'; }
utc_date_iso() { printf '2026-07-10\\n'; }
list_public_package_info() { printf 'cli\\tpaperclipai\\t0.0.0\\n'; }
next_stable_version() { printf '2026.710.0\\n'; }
next_prerelease_version() { printf '2026.710.0-%s.0\\n' "$1"; }
release_notes_file() { printf '%s/releases/v%s.md\\n' "$REPO_ROOT" "$1"; }
stable_tag_name() { printf 'v%s\\n' "$1"; }
prerelease_tag_name() { printf '%s/v%s\\n' "$1" "$2"; }
require_channel_tag_at_head() {
  if [ "\${FAKE_MISSING_CHANNEL_TAG:-}" = "$1" ]; then
    echo "Error: HEAD has no $1/v* tag; this channel only publishes commits that already shipped a $1 release." >&2
    exit 1
  fi
  echo "[fixture] require_channel_tag_at_head $1"
}
require_channel_tag_absent_at_head() {
  if [ "\${FAKE_PRESENT_CHANNEL_TAG:-}" = "$1" ]; then
    echo "Error: HEAD already shipped as $1/v2026.710.0-$1.0; delete that tag first if you really want to republish this commit on the $1 channel." >&2
    exit 1
  fi
  echo "[fixture] require_channel_tag_absent_at_head $1"
}
require_clean_worktree() { :; }
require_npm_publish_auth() { :; }
git_local_tag_exists() { return 1; }
git_remote_tag_exists() { return 1; }
npm_package_version_exists() { return 1; }
set_public_package_version() { :; }
`,
  );

  writeExecutable(
    join(scriptsDir, "release-registry-versions.mjs"),
    `#!/usr/bin/env node
const [mode] = process.argv.slice(2);
if (mode === "fetch") {
  process.stdout.write('{"paperclipai":[]}\\n');
  process.exit(0);
}
if (mode === "assert-absent") {
  process.exit(0);
}
process.exit(2);
`,
  );

  writeExecutable(
    join(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-C" ]; then
  shift 2
fi
printf 'git %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1" in
  rev-parse)
    if [ "\${2:-}" = "HEAD" ]; then
      echo abcdef1234567890
      exit 0
    fi
    ;;
  diff|ls-files)
    exit 0
    ;;
  checkout)
    exit 0
    ;;
esac
exit 0
`,
  );

  writeExecutable(
    join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [ "$*" = "build" ]; then
  echo "fixture stopped at workspace build"
  exit 42
fi
exit 0
`,
  );

  return { binDir, callLog, fixtureDir, script: join(scriptsDir, "release.sh") };
}

function runRelease(args, extraEnv = {}) {
  const fixture = createReleaseFixture();
  const result = spawnSync(fixture.script, args, {
    cwd: fixture.fixtureDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      FAKE_CALL_LOG: fixture.callLog,
      ...extraEnv,
    },
  });

  const calls = readFileSync(fixture.callLog, "utf8");
  rmSync(fixture.fixtureDir, { recursive: true, force: true });

  return {
    calls,
    output: result.stdout + result.stderr,
    status: result.status,
  };
}

test("stable dry-run preview does not require a pre-authored release notes file", () => {
  const result = runRelease(["stable", "--skip-verify", "--dry-run"]);

  assert.equal(result.status, 42);
  assert.match(result.output, /==> Release plan/);
  assert.match(result.output, /==> Step 2\/7: Building workspace artifacts/);
  assert.doesNotMatch(result.output, /stable release notes file is required/);
  assert.match(result.calls, /^pnpm build$/m);
});

test("stable publish still requires release notes before publish work starts", () => {
  const result = runRelease(["stable", "--skip-verify"]);

  assert.equal(result.status, 1);
  assert.match(result.output, /stable release notes file is required/);
  assert.doesNotMatch(result.output, /==> Step 2\/7: Building workspace artifacts/);
  assert.doesNotMatch(result.calls, /^pnpm /m);
});

test("nightly dry-run publishes under the nightly identity without release notes", () => {
  const result = runRelease(["nightly", "--skip-verify", "--dry-run"]);

  assert.equal(result.status, 42);
  assert.match(result.output, /\[fixture\] require_channel_tag_at_head canary/);
  assert.match(result.output, /Nightly version: 2026\.710\.0-nightly\.0/);
  assert.match(result.output, /Dist-tag: nightly/);
  assert.match(result.output, /Git tag: nightly\/v2026\.710\.0-nightly\.0/);
  assert.doesNotMatch(result.output, /stable release notes file is required/);
  assert.match(result.calls, /^pnpm build$/m);
});

test("nightly refuses commits that never shipped a canary", () => {
  const result = runRelease(["nightly", "--skip-verify", "--dry-run"], {
    FAKE_MISSING_CHANNEL_TAG: "canary",
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /HEAD has no canary\/v\* tag/);
  assert.doesNotMatch(result.calls, /^pnpm /m);
});

test("nightly refuses commits that already shipped as a nightly", () => {
  const result = runRelease(["nightly", "--skip-verify", "--dry-run"], {
    FAKE_PRESENT_CHANNEL_TAG: "nightly",
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /HEAD already shipped as nightly\/v/);
  assert.doesNotMatch(result.calls, /^pnpm /m);
});
