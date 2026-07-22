import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "release-registry-versions.mjs");

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function makeFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-registry-"));
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  writeFileSync(callLog, "");

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
target="$2"
case "$target" in
  "@paperclipai/present@"*)
    printf '%s\\n' "\${target##*@}"
    ;;
  "@paperclipai/absent@"*)
    exit 1
    ;;
  "@paperclipai/present")
    echo '["1.0.0","2026.707.0","2026.707.1","2026.707.1-canary.4"]'
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  return { fixtureDir, binDir, callLog };
}

function runScript(args, { binDir, callLog }, extraEnv = {}) {
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
  }
  return { status, stdout, stderr, calls: readFileSync(callLog, "utf8") };
}

function runReleaseLibHelper(fnCall, { binDir, callLog }, extraEnv = {}) {
  const script = `
set -euo pipefail
source "${repoRoot}/scripts/release-lib.sh"
${fnCall}
`;
  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        REPO_ROOT: repoRoot,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  return { status, output, calls: readFileSync(callLog, "utf8") };
}

test("fetch prints a JSON version map and treats missing packages as empty", () => {
  const fixture = makeFixture();
  const result = runScript(["fetch", "@paperclipai/present", "@paperclipai/missing"], fixture);

  assert.equal(result.status, 0);
  const map = JSON.parse(result.stdout);
  assert.deepEqual(map["@paperclipai/present"], [
    "1.0.0",
    "2026.707.0",
    "2026.707.1",
    "2026.707.1-canary.4",
  ]);
  assert.deepEqual(map["@paperclipai/missing"], []);
  assert.match(result.calls, /^npm view @paperclipai\/present versions --json$/m);
  assert.match(result.calls, /^npm view @paperclipai\/missing versions --json$/m);
});

test("assert-absent succeeds when no package has the version", () => {
  const fixture = makeFixture();
  const result = runScript(
    ["assert-absent", "2026.707.2", "@paperclipai/absent", "@paperclipai/absent"],
    fixture,
  );

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/absent@2026\.707\.2 version$/m);
});

test("assert-absent fails and names packages that already have the version", () => {
  const fixture = makeFixture();
  const result = runScript(
    ["assert-absent", "2026.707.2", "@paperclipai/present", "@paperclipai/absent"],
    fixture,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm version @paperclipai\/present@2026\.707\.2 already exists\./);
  assert.doesNotMatch(result.stderr, /@paperclipai\/absent@/);
});

test("invalid concurrency fails instead of skipping registry checks", () => {
  const fixture = makeFixture();
  const result = runScript(["assert-absent", "2026.707.2", "@paperclipai/present"], fixture, {
    RELEASE_REGISTRY_CONCURRENCY: "0",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /RELEASE_REGISTRY_CONCURRENCY must be a positive integer\./);
  assert.equal(result.calls, "");
});

test("next_stable_version reads RELEASE_PACKAGE_VERSIONS_FILE without calling npm", () => {
  const fixture = makeFixture();
  const versionsFile = join(fixture.fixtureDir, "versions.json");
  writeFileSync(
    versionsFile,
    JSON.stringify({
      "@paperclipai/a": ["2026.707.0", "2026.707.1", "2026.707.1-canary.4"],
      "@paperclipai/b": [],
    }),
  );

  const result = runReleaseLibHelper(
    'next_stable_version 2026-07-07 "@paperclipai/a" "@paperclipai/b"',
    fixture,
    { RELEASE_PACKAGE_VERSIONS_FILE: versionsFile },
  );

  assert.equal(result.status, 0);
  assert.equal(result.output, "2026.707.2");
  assert.doesNotMatch(result.calls, /npm view/);
});

test("next_canary_version reads RELEASE_PACKAGE_VERSIONS_FILE without calling npm", () => {
  const fixture = makeFixture();
  const versionsFile = join(fixture.fixtureDir, "versions.json");
  writeFileSync(
    versionsFile,
    JSON.stringify({
      "@paperclipai/a": ["2026.707.0", "2026.707.1", "2026.707.1-canary.4"],
    }),
  );

  const result = runReleaseLibHelper('next_canary_version 2026.707.1 "@paperclipai/a"', fixture, {
    RELEASE_PACKAGE_VERSIONS_FILE: versionsFile,
  });

  assert.equal(result.status, 0);
  assert.equal(result.output, "2026.707.1-canary.5");
  assert.doesNotMatch(result.calls, /npm view/);
});

test("next_stable_version falls back to npm view without a versions file", () => {
  const fixture = makeFixture();
  const result = runReleaseLibHelper('next_stable_version 2026-07-07 "@paperclipai/present"', fixture);

  assert.equal(result.status, 0);
  assert.equal(result.output, "2026.707.2");
  assert.match(result.calls, /^npm view @paperclipai\/present versions --json$/m);
});
