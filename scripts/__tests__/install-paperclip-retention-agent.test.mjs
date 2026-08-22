import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../install-paperclip-retention-agent.sh", import.meta.url).pathname;

const cleanupDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function run(args, envOverrides, fakeHome) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome,
      // Exercise the real file-generation logic on any CI runner OS, but
      // never mutate a real launchd (see script comments for why).
      PAPERCLIP_RETENTION_ASSUME_DARWIN: "1",
      PAPERCLIP_RETENTION_SKIP_LAUNCHCTL: "1",
      ...envOverrides,
    },
  });
}

test("--help prints usage and exits 0", () => {
  const home = makeTempDir("retention-agent-help-");
  const result = run(["--help"], {}, home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("no action prints usage and exits 2", () => {
  const home = makeTempDir("retention-agent-noaction-");
  const result = run([], {}, home);
  assert.equal(result.status, 2);
});

test("--status on a never-installed label reports not loaded", () => {
  const home = makeTempDir("retention-agent-status-");
  const result = run(["--status"], { PAPERCLIP_RETENTION_LABEL: "ai.paperclip.test-not-installed" }, home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not loaded/);
});

test("--install writes a plist and a runner script under HOME, and is idempotent", () => {
  const home = makeTempDir("retention-agent-install-");
  const label = "ai.paperclip.test-install";
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");

  const first = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label, PAPERCLIP_RETENTION_INTERVAL_SECS: "1800" }, home);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(plistPath), "plist should be written");
  assert.ok(fs.existsSync(runnerPath), "runner script should be written");

  const plistContent = fs.readFileSync(plistPath, "utf8");
  assert.match(plistContent, /<string>ai\.paperclip\.test-install<\/string>/);
  assert.match(plistContent, /<integer>1800<\/integer>/);
  assert.doesNotMatch(plistContent, /StartCalendarInterval/, "must use StartInterval, not cron-style calendar keys");

  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  assert.match(runnerContent, /reap-stale-workspaces\.mjs/);
  assert.ok(fs.statSync(runnerPath).mode & 0o111, "runner script must be executable");

  // Re-running --install must not fail or error out (idempotency of the
  // installer itself, independent of the reaper's own idempotency).
  const second = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(fs.existsSync(plistPath));
});

test("--install bakes an absolute node path into the runner (regression guard: launchd's minimal PATH cannot resolve a bare 'node')", () => {
  // Found by actually `launchctl kickstart`-triggering the installed job on a
  // real host: the runner used to re-resolve `command -v node` at RUN time,
  // but launchd jobs run with a minimal PATH that does not include Homebrew
  // (or nvm) bin dirs, so that resolution silently failed every single run.
  // The fix resolves node ONCE at install time (this script's own, full,
  // interactive PATH) and bakes the absolute path into the generated runner.
  const home = makeTempDir("retention-agent-node-path-");
  const label = "ai.paperclip.test-node-path";
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");

  const result = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(result.status, 0, result.stderr);
  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  const nodeAbsolutePath = spawnSync("bash", ["-lc", "command -v node"], { encoding: "utf8" }).stdout.trim();
  assert.ok(nodeAbsolutePath.startsWith("/"), "test environment must have a resolvable node for this assertion to be meaningful");
  assert.match(
    runnerContent,
    new RegExp(`NODE_BIN="${nodeAbsolutePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    "the runner must bake the absolute, install-time-resolved node path, not re-resolve a bare 'node' at run time",
  );
});

test("--install refuses to install when node cannot be resolved at all (fail closed, not a silently-broken job)", () => {
  const home = makeTempDir("retention-agent-no-node-");
  const label = "ai.paperclip.test-no-node";
  // PATH must still resolve bash itself (via an absolute interpreter path
  // below) and basic coreutils, but must NOT resolve node — /usr/bin:/bin
  // never ships node on macOS or typical Linux CI images.
  const result = spawnSync("/bin/bash", [script, "--install"], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      PAPERCLIP_RETENTION_LABEL: label,
      PAPERCLIP_RETENTION_ASSUME_DARWIN: "1",
      PAPERCLIP_RETENTION_SKIP_LAUNCHCTL: "1",
    },
  });
  assert.notEqual(result.status, 0, "must fail rather than install a job that would always silently no-op");
  assert.match(result.stderr, /node.*not found/i);
});

test("--install never touches crontab or /etc/cron*", () => {
  const home = makeTempDir("retention-agent-nocron-");
  const label = "ai.paperclip.test-nocron";
  const result = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /crontab/i);
});

test("--uninstall removes the plist", () => {
  const home = makeTempDir("retention-agent-uninstall-");
  const label = "ai.paperclip.test-uninstall";
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);

  const install = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(install.status, 0, install.stderr);
  assert.ok(fs.existsSync(plistPath));

  const uninstall = run(["--uninstall"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(plistPath), false, "plist must be removed after --uninstall");
});

test("report-only mode (PAPERCLIP_RETENTION_APPLY=0) omits --apply from the generated runner", () => {
  const home = makeTempDir("retention-agent-reportonly-");
  const label = "ai.paperclip.test-reportonly";
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");
  const result = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label, PAPERCLIP_RETENTION_APPLY: "0" }, home);
  assert.equal(result.status, 0, result.stderr);
  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  assert.doesNotMatch(runnerContent, /reap-stale-workspaces\.mjs.*--apply/);
});

test("PAPERCLIP_RETENTION_MAX_LOG_BYTES defaults to 5 MiB and is baked into the runner's rotation logic", () => {
  const home = makeTempDir("retention-agent-logdefault-");
  const label = "ai.paperclip.test-logdefault";
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");
  const result = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label }, home);
  assert.equal(result.status, 0, result.stderr);
  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  assert.match(runnerContent, /MAX_LOG_BYTES="5242880"/);
  assert.match(runnerContent, /rotate_log_if_large/);
});

test("the generated runner rotates an oversized stdout.log in place (copytruncate), preserving both the old content and this run's own output (regression guard: an unbounded launchd log would recreate the disk crisis this agent exists to fix)", () => {
  const home = makeTempDir("retention-agent-logrotate-");
  const label = "ai.paperclip.test-logrotate";
  const logDir = path.join(home, ".paperclip", "retention-agent", "logs");
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");

  const install = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label, PAPERCLIP_RETENTION_MAX_LOG_BYTES: "200" }, home);
  assert.equal(install.status, 0, install.stderr);
  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  assert.match(runnerContent, /MAX_LOG_BYTES="200"/);

  // Pre-seed an oversized stdout.log, as if several prior hourly runs had
  // accumulated output with no cap at all.
  fs.mkdirSync(logDir, { recursive: true });
  const oldContent = `OLD-RUN-OUTPUT-${"x".repeat(500)}\n`;
  const stdoutLog = path.join(logDir, "stdout.log");
  const stderrLog = path.join(logDir, "stderr.log");
  fs.writeFileSync(stdoutLog, oldContent);

  // Invoke the runner the way launchd actually does: fd 1/2 opened in
  // APPEND mode on these exact paths before the script starts, and held
  // open for the runner's entire lifetime. A naive test that instead pipes
  // /captures the child's output (rather than pre-opening these exact
  // files) would not catch a rename-based rotation bug, since the
  // vulnerability is specifically about an already-open fd on THIS path.
  const invoke = spawnSync("bash", ["-c", 'exec "$1" >>"$2" 2>>"$3"', "_", runnerPath, stdoutLog, stderrLog], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(invoke.status, 0, invoke.stderr);

  assert.equal(
    fs.readFileSync(path.join(logDir, "stdout.log.1"), "utf8"),
    oldContent,
    "the oversized prior content must be preserved in a single rotated .1 backup, not silently discarded",
  );
  const liveLog = fs.readFileSync(stdoutLog, "utf8");
  assert.doesNotMatch(
    liveLog,
    /OLD-RUN-OUTPUT/,
    "the live log must have been truncated, not left growing forever",
  );
  assert.match(
    liveLog,
    /reap-stale-workspaces/,
    "THIS run's own output must land in the live (rotated) log file, not be lost or misdirected into the renamed-away old file",
  );
});

test("the generated runner's log rotation is a no-op while a log stays under the configured size cap", () => {
  const home = makeTempDir("retention-agent-logrotate-noop-");
  const label = "ai.paperclip.test-logrotate-noop";
  const logDir = path.join(home, ".paperclip", "retention-agent", "logs");
  const runnerPath = path.join(home, ".paperclip", "retention-agent", "run.sh");

  const install = run(["--install"], { PAPERCLIP_RETENTION_LABEL: label, PAPERCLIP_RETENTION_MAX_LOG_BYTES: "1000000" }, home);
  assert.equal(install.status, 0, install.stderr);

  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "stdout.log"), "small prior line\n");

  const invoke = spawnSync("bash", [runnerPath], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(invoke.status, 0, invoke.stderr);
  assert.equal(
    fs.existsSync(path.join(logDir, "stdout.log.1")),
    false,
    "must not rotate (or otherwise touch) a log that is still under the size cap",
  );
  assert.match(fs.readFileSync(path.join(logDir, "stdout.log"), "utf8"), /small prior line/);
});
