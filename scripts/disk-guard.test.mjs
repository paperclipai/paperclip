import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "disk-guard.sh");

// Exit codes documented in the script header.
const RC_OK = 0;
const RC_ERROR = 1;
const RC_WARN = 2;
const RC_CRITICAL = 3;

const MIB = 1024 * 1024;

function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "disk-guard-test-"));
  const mount = path.join(root, "mnt");
  const binDir = path.join(root, "bin");
  mkdirSync(mount);
  mkdirSync(binDir);
  return {
    root,
    mount,
    binDir,
    statusFile: path.join(root, "run", "disk-guard.status"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Shadow `df` with a stub so usage is deterministic and independent of the real
 * filesystem. The script calls `df --block-size=1 -P "$MOUNT"`; size/used/avail
 * are emitted in 1-byte blocks, matching what the script's awk expects.
 *
 * `broken: true` makes the stub fail the way an unmounted or unreadable volume
 * does, which is how we exercise the measurement-failure path.
 */
function installDfStub(sandbox, { size, used, avail, broken = false }) {
  const lines = broken
    ? "#!/bin/sh\nexit 1\n"
    : [
        "#!/bin/sh",
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
        `echo "stub ${size} ${used} ${avail} 50% /mnt"`,
        "",
      ].join("\n");
  const stub = path.join(sandbox.binDir, "df");
  writeFileSync(stub, lines, { mode: 0o755 });
  return stub;
}

function run(sandbox, args, env = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_COMPANY_ID: "company-1",
      DISK_GUARD_WORKSPACES_DIR: path.join(sandbox.mount, "instances/default/workspaces"),
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function seed(sandbox, relPath, sizeBytes) {
  const full = path.join(sandbox.mount, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(sizeBytes));
  return full;
}

function exists(sandbox, relPath) {
  return existsSync(path.join(sandbox.mount, relPath));
}

function installPaperclipApiStub(sandbox, { roster = ["agent-1"], issues = { "DEF-1": "done" }, ignoreQuery = false } = {}) {
  const stub = path.join(sandbox.binDir, "paperclip-api-stub.mjs");
  const body = [
    "#!/usr/bin/env node",
    `const roster = ${JSON.stringify(roster)};`,
    `const issues = ${JSON.stringify(issues)};`,
    "const requestPath = process.argv[2] || '';",
    "if (requestPath.includes('/agents')) { console.log(JSON.stringify(roster.map((id) => ({ id })))); process.exit(0); }",
    `const ignoreQuery = ${JSON.stringify(ignoreQuery)};`,
    "const match = requestPath.match(/[?&]q=([^&]+)/);",
    "const identifier = match ? decodeURIComponent(match[1]) : '';",
    "if (ignoreQuery) { console.log(JSON.stringify({ items: [{ identifier: 'DEF-999', status: 'done' }] })); process.exit(0); }",
    "const status = issues[identifier] || 'todo';",
    "console.log(JSON.stringify({ items: [{ identifier, status }] }));",
    "",
  ].join("\n");
  writeFileSync(stub, body);
  chmodSync(stub, 0o755);
  return stub;
}

function seedWorkspaceCheckout(sandbox, { agentId = "agent-1", checkoutName = "repo", issue = "DEF-1", rel = "client/target", ignored = true, tracked = false, fresh = false, worktree = false } = {}) {
  const workspace = path.join(sandbox.mount, "instances/default/workspaces", agentId);
  const checkout = worktree
    ? path.join(workspace, "repo", ".paperclip", "worktrees", checkoutName)
    : path.join(workspace, checkoutName);
  if (worktree) {
    const base = path.join(workspace, "repo");
    mkdirSync(base, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: base });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: base });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: base });
    writeFileSync(path.join(base, "README.md"), "test\n");
    spawnSync("git", ["add", "README.md"], { cwd: base });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: base });
    mkdirSync(path.dirname(checkout), { recursive: true });
    spawnSync("git", ["worktree", "add", "-q", "-b", issue.toLowerCase(), checkout, "HEAD"], { cwd: base });
  } else {
    mkdirSync(checkout, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: checkout });
    spawnSync("git", ["checkout", "-b", issue.toLowerCase()], { cwd: checkout });
  }
  if (ignored) writeFileSync(path.join(checkout, ".gitignore"), `${rel}\n`);
  const full = path.join(checkout, rel, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (tracked) {
    spawnSync("git", ["add", "-f", path.join(rel, "blob")], { cwd: checkout });
  }
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(checkout, rel), old, old);
  }
  return { checkout, full };
}

/**
 * Seed `$MOUNT/cargo-target-shared/<name>/blob`. The shared cargo target root is
 * the guard's second deletion-capable path, and it resolves the owning issue
 * from an in-band marker rather than from the directory name, so its gates need
 * their own coverage.
 *
 * `marker` is what gets written to the ownership marker file: a string to
 * attribute the dir, `false` to write no marker at all, `true` for a marker that
 * agrees with the directory name.
 */
function seedCargoTarget(sandbox, { name, fresh = false, symlink = false, marker = true } = {}) {
  const root = path.join(sandbox.mount, "cargo-target-shared");
  const full = path.join(root, name, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (marker !== false) {
    const owner = marker === true
      ? name.replace(/^([a-z]+)-([0-9]+)$/, (_m, k, n) => `${k.toUpperCase()}-${n}`)
      : marker;
    const markerFile = path.join(path.dirname(full), ".paperclip-owner");
    writeFileSync(markerFile, `${owner}\n`);
    if (!fresh) {
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      utimesSync(markerFile, old, old);
    }
  }
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(root, name), old, old);
  }
  if (symlink) {
    const outside = path.join(sandbox.root, "outside-cargo-target");
    mkdirSync(outside, { recursive: true });
    renameSync(path.dirname(full), path.join(outside, "real"));
    rmSync(path.join(sandbox.mount, "cargo-target-shared", name), { recursive: true, force: true });
    symlinkSync(path.join(outside, "real"), path.join(root, name));
  }
  return full;
}

/** Total bytes of file content under `dir`, used to assert prune freed nothing. */
function treeBytes(dir) {
  const result = spawnSync("find", [dir, "-type", "f", "-printf", "%s\n"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`find failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reduce((sum, line) => sum + Number(line), 0);
}

test("threshold and floor logic: WARN_PCT=1 yields rc=2", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_WARN_PCT: "1", DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_WARN);
    assert.match(result.stdout, /level=warn/);
  } finally {
    sandbox.cleanup();
  }
});

test("threshold and floor logic: CRIT_PCT=1 yields rc=3", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_CRITICAL);
    assert.match(result.stdout, /level=critical/);
  } finally {
    sandbox.cleanup();
  }
});

test("a healthy volume under both thresholds yields rc=0", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"]);
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /level=ok/);
  } finally {
    sandbox.cleanup();
  }
});

test("a MIN_FREE_MB above available free space trips warn even at low usage", () => {
  const sandbox = makeSandbox();
  try {
    // 5% used, so percentage is nowhere near WARN_PCT=88. Only the free-space
    // floor can make this warn.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 2 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_MIN_FREE_MB: "100000" });
    assert.equal(result.status, RC_WARN);
    assert.match(result.stdout, /level=warn/);
  } finally {
    sandbox.cleanup();
  }
});

test("MIN_FREE_MB=0 disables the floor, leaving percentage as the only signal", () => {
  const sandbox = makeSandbox();
  try {
    // Same starved free space as above, but the floor is disabled.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 2 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /level=ok/);
    assert.match(result.stdout, /floor=0MiB/);
  } finally {
    sandbox.cleanup();
  }
});

test("unparseable usage is a measurement error (rc=1), not a pressure signal", () => {
  const sandbox = makeSandbox();
  try {
    // An unreadable/unmounted volume makes df produce no usable row. This must
    // not be reported as ok/warn: the guard simply could not measure.
    installDfStub(sandbox, { broken: true });
    const result = run(sandbox, ["--check"]);
    assert.equal(result.status, RC_ERROR);
    assert.doesNotMatch(result.stdout, /level=/, "must not publish a level it could not measure");
    assert.match(result.stderr, /cannot measure/);
  } finally {
    sandbox.cleanup();
  }
});

test("an unknown mode is a usage error (rc=1)", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--bogus"]);
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stderr, /usage: disk-guard\.sh/);
  } finally {
    sandbox.cleanup();
  }
});

test("--status reads the durable state file written by a previous --check", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    run(sandbox, ["--check"]);
    const result = run(sandbox, ["--status"]);
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /^mount=/m);
    assert.match(result.stdout, /^level=ok$/m);
  } finally {
    sandbox.cleanup();
  }
});

test("allowlist: prune deletes only the approved cache paths", () => {
  const sandbox = makeSandbox();
  try {
    // Force pressure so prune is allowed to run at all; CRIT_PCT=1 guarantees
    // critical regardless of the stub's numbers.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const approved = [
      ".cache/node/blob",
      ".cache/zig/blob",
      ".cache/opencode/blob",
      ".cache/pnpm/blob",
      ".cache/ms-playwright/blob",
      ".npm/_cacache/blob",
      ".npm/_npx/blob",
    ];
    const forbidden = [
      "instances/default/keep",
      "wt/repo/keep",
      "opencode.db",
      "opencode.db-wal",
      ".nix-portable/store/keep",
      ".rustup/toolchains/keep",
      ".local/share/opencode/opencode.db",
      ".local/share/opencode/opencode.db-wal",
      ".local/share/pnpm/store/blob",
    ];
    for (const rel of [...approved, ...forbidden]) {
      seed(sandbox, rel, 3 * MIB);
    }

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);

    for (const rel of approved) {
      assert.ok(!exists(sandbox, rel), `expected ${rel} to be pruned`);
    }
    for (const rel of forbidden) {
      assert.ok(exists(sandbox, rel), `expected ${rel} to survive the prune`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test("allowlist: prune only removes rotated logs (mtime>1d) from the log dir", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const oldLog = seed(sandbox, ".local/share/opencode/log/old.log", 2 * MIB);
    const freshLog = seed(sandbox, ".local/share/opencode/log/fresh.log", 2 * MIB);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(oldLog, threeDaysAgo, threeDaysAgo);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(oldLog), "expected the rotated log to be deleted");
    assert.ok(existsSync(freshLog), "expected the current log to be kept");
  } finally {
    sandbox.cleanup();
  }
});

test("nlink gate: a cache hardlinked into a live node_modules is skipped, not deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // .cache/pnpm is on the prune allowlist, so the gate is what stands between
    // it and deletion: its inodes are shared with a live node_modules tree, so
    // reclaim measured with `-links 1` is 0 and the path must take the skip
    // branch. This mirrors the real volume, where the analogous pnpm store
    // frees only ~15M while breaking hardlink dedup.
    const liveBlob = seed(sandbox, "live/node_modules/dep/blob", 5 * MIB);
    const cacheBlob = path.join(sandbox.mount, ".cache/pnpm/store/blob");
    mkdirSync(path.dirname(cacheBlob), { recursive: true });
    linkSync(liveBlob, cacheBlob);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(cacheBlob), "hardlinked cache must survive (skip branch)");
    assert.ok(existsSync(liveBlob), "the live tree sharing the inode must survive");
    assert.match(result.stderr, /skip .*\.cache\/pnpm \(only 0KiB unlinked-reclaimable\)/);
  } finally {
    sandbox.cleanup();
  }
});

test("nlink gate: the same allowlisted cache with its own inodes is pruned", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // Control case for the test above: identical path and size, but nlink==1,
    // so it is genuinely reclaimable and must be deleted. Without this, the
    // skip branch could pass simply because the path was mis-seeded.
    const cacheBlob = seed(sandbox, ".cache/pnpm/blob", 5 * MIB);
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(cacheBlob), "an unhardlinked cache must be pruned");
    assert.ok(
      treeBytes(sandbox.mount) < bytesBefore,
      "pruning must actually reclaim the space it reported",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("prune is a no-op at level=ok: nothing is deleted and exactly 0 bytes are freed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const logBlob = seed(sandbox, ".local/share/opencode/log/old.log", 2 * MIB);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(logBlob, threeDaysAgo, threeDaysAgo);
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "99" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /prune_skipped=level_ok/);
    // The skip path returns before prune prints its reclaimed_mib line, so
    // measure the tree directly: 0 bytes freed is the property under test.
    assert.equal(treeBytes(sandbox.mount) - bytesBefore, 0, "prune must free exactly 0 bytes at level=ok");
    assert.ok(existsSync(cacheBlob), "cache must be untouched when there is no pressure");
    assert.ok(existsSync(logBlob), "logs must be untouched when there is no pressure");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: closed issue build output is pruned and failing gates survive", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-1": "done", "DEF-2": "todo", "DEF-3": "done", "DEF-4": "done", "DEF-5": "done", "DEF-6": "done" },
    });
    const closed = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-1", issue: "DEF-1" });
    const open = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-2", issue: "DEF-2" });
    const tracked = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-3", issue: "DEF-3", tracked: true });
    const notIgnored = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-4", issue: "DEF-4", ignored: false });
    const fresh = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-5", issue: "DEF-5", fresh: true });
    const outsider = seedWorkspaceCheckout(sandbox, { agentId: "agent-2", checkoutName: "repo-6", issue: "DEF-6" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(closed.full), "closed issue build output in a roster workspace must be pruned");
    assert.ok(existsSync(open.full), "open issue build output must survive");
    assert.ok(existsSync(tracked.full), "tracked build output must survive");
    assert.ok(existsSync(notIgnored.full), "non-gitignored build output must survive");
    assert.ok(existsSync(fresh.full), "fresh build output must survive");
    assert.ok(existsSync(outsider.full), "workspace outside the company roster must survive");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: ignored issue filters and rejects mismatched issue identifiers", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], ignoreQuery: true });
    const checkout = seedWorkspaceCheckout(sandbox, { checkoutName: "repo", issue: "DEF-7" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(checkout.full), "mismatched API results must not authorize deletion");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: linked worktrees with .git files are scanned", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-8": "done" } });
    const checkout = seedWorkspaceCheckout(sandbox, { checkoutName: "linked", issue: "DEF-8", worktree: true });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(checkout.full), "linked worktree build output must be pruned when all gates pass");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: directory names and symlinks do not authorize deletion", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-9": "done", "DEF-10": "done" } });
    const branchOnly = seedWorkspaceCheckout(sandbox, { checkoutName: "def-9", issue: "feature-open" });
    const symlinkCheckout = seedWorkspaceCheckout(sandbox, { checkoutName: "repo-symlink", issue: "DEF-10" });
    const outside = path.join(sandbox.mount, "outside");
    mkdirSync(outside);
    rmSync(path.dirname(symlinkCheckout.full), { recursive: true, force: true });
    symlinkSync(outside, path.dirname(symlinkCheckout.full));

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(branchOnly.full), "checkout directory names must not determine issue ownership");
    assert.ok(existsSync(path.dirname(symlinkCheckout.full)), "symlinked candidates must survive");
  } finally {
    sandbox.cleanup();
  }
});

test("prune gates on this invocation's measured level instead of stale status", () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(path.dirname(sandbox.statusFile), { recursive: true });
    writeFileSync(sandbox.statusFile, "level=critical\n");
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "99" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /prune_skipped=level_ok/);
    assert.ok(existsSync(cacheBlob), "stale critical status must not authorize pruning");
  } finally {
    sandbox.cleanup();
  }
});

test("prune fails closed when df is unusable, rather than trusting a stale status file", () => {
  const sandbox = makeSandbox();
  try {
    // A previous run left level=critical in the durable status file. If prune
    // trusted that stale reading while df was broken it would delete caches
    // without having measured anything.
    mkdirSync(path.dirname(sandbox.statusFile), { recursive: true });
    writeFileSync(sandbox.statusFile, "level=critical\n");
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    installDfStub(sandbox, { broken: true });

    const result = run(sandbox, ["--prune"]);
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stdout, /prune_skipped=measurement_failed/);
    assert.ok(existsSync(cacheBlob), "cache must survive an unmeasurable run");
  } finally {
    sandbox.cleanup();
  }
});

test("cargo target scope: closed issue target dir is pruned and failing gates survive", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-1": "done", "DEF-2": "todo", "DEF-3": "done", "DEF-4": "done", "DEF-5": "done", "DEF-6": "done", "DEF-7": "done", "DEF-8": "done" },
    });
    // The root dir name is lowercased on disk and uppercased by the script, so
    // "def-1" must still resolve to the DEF-1 issue in the control plane.
    const closed = seedCargoTarget(sandbox, { name: "def-1" });
    const open = seedCargoTarget(sandbox, { name: "def-2" });
    const fresh = seedCargoTarget(sandbox, { name: "def-3", fresh: true });
    const unnamed = seedCargoTarget(sandbox, { name: "shared-fallback" });
    const unmarked = seedCargoTarget(sandbox, { name: "def-4", marker: false });
    const misattributed = seedCargoTarget(sandbox, { name: "def-5", marker: "DEF-6" });
    const symlink = seedCargoTarget(sandbox, { name: "def-7", symlink: true });
    // A marker that is itself a symlink would let a dir outside the mount
    // dictate what this one claims to own.
    const linkedMarker = seedCargoTarget(sandbox, { name: "def-8" });
    rmSync(path.join(path.dirname(linkedMarker), ".paperclip-owner"), { force: true });
    const outsideMarker = path.join(sandbox.root, "outside-marker");
    writeFileSync(outsideMarker, "DEF-8\n");
    const markerLink = path.join(path.dirname(linkedMarker), ".paperclip-owner");
    symlinkSync(outsideMarker, markerLink);
    // Age the link and its parent: creating the link refreshes the directory
    // mtime, and find reports it, so without this the min-age gate would skip
    // the dir and hide the result. find reports the symlink's own mtime, so
    // utimes on the link would age the target instead and not help.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    lutimesSync(markerLink, old, old);
    lutimesSync(path.dirname(linkedMarker), old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(closed), "closed issue cargo target must be pruned");
    assert.ok(existsSync(open), "open issue cargo target must survive");
    assert.ok(existsSync(fresh), "cargo target under the min-age gate must survive");
    assert.ok(existsSync(unnamed), "a dir that is not named after an issue must survive");
    assert.ok(existsSync(unmarked), "a dir with no ownership marker must survive");
    assert.ok(existsSync(misattributed), "a dir whose marker names another issue must survive");
    assert.ok(existsSync(linkedMarker), "a symlinked ownership marker must survive");
    // Assert the gate's own refusal, not just that the file survived: `find
    // -xdev` and `rm -rf` both refuse to descend a symlink anyway, so survival
    // alone would not catch the symlink check being deleted.
    assert.match(result.stderr, /candidate is a symlink/);
    assert.match(result.stderr, /not a per-issue target dir/);
    assert.match(result.stderr, /is not terminal/);
    assert.match(result.stderr, /no \.paperclip-owner ownership marker/);
    assert.match(result.stderr, /marker says 'DEF-6', dir says 'DEF-5'/);
  } finally {
    sandbox.cleanup();
  }
});

test("cargo target scope: a mis-named dir borrows no status from another issue", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // The stub ignores the `q=` filter and answers with an unrelated issue that
    // happens to be done. Without an identifier match the guard must refuse.
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], ignoreQuery: true });
    const target = seedCargoTarget(sandbox, { name: "def-1" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(target), "mismatched API results must not authorize cargo target deletion");
  } finally {
    sandbox.cleanup();
  }
});

test("a missing company id is a loud prune error, not a wrong-tenant lookup", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const env = { ...process.env };
    delete env.DISK_GUARD_COMPANY_ID;
    delete env.PAPERCLIP_COMPANY_ID;
    const base = {
      ...env,
      PATH: `${sandbox.binDir}:${env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_CRIT_PCT: "1",
    };
    const result = spawnSync("bash", [SCRIPT, "--prune"], { encoding: "utf8", env: base });
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stderr, /no company id/);
    assert.ok(existsSync(cacheBlob), "a prune with no company id must not delete anything");
  } finally {
    sandbox.cleanup();
  }
});

test("--check and --status work with no company id, because neither queries issues", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const env = { ...process.env };
    delete env.DISK_GUARD_COMPANY_ID;
    delete env.PAPERCLIP_COMPANY_ID;
    const base = {
      ...env,
      PATH: `${sandbox.binDir}:${env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_CRIT_PCT: "1",
    };
    // A guard that cannot measure pressure when the environment is incomplete is
    // worse than one that cannot reclaim: the blind spot is invisible until the
    // volume is already full.
    const check = spawnSync("bash", [SCRIPT, "--check"], { encoding: "utf8", env: base });
    assert.equal(check.status, RC_CRITICAL);
    assert.match(check.stdout, /level=critical/);
    const status = spawnSync("bash", [SCRIPT, "--status"], { encoding: "utf8", env: base });
    assert.equal(status.status, RC_OK);
    assert.match(status.stdout, /level=critical/);
    assert.ok(existsSync(cacheBlob), "monitoring must never delete");
  } finally {
    sandbox.cleanup();
  }
});

test("the committed script stays in sync with the deployed runtime copies", { skip: process.env.DISK_GUARD_SKIP_SYNC_CHECK === "1" }, () => {
  const committed = readFileSync(SCRIPT);
  for (const runtimeCopy of ["/paperclip/bin/disk-guard.sh", "/paperclip/disk-guard.sh"]) {
    if (!existsSync(runtimeCopy)) continue;
    const deployed = readFileSync(runtimeCopy);
    assert.ok(
      deployed.equals(committed),
      `${runtimeCopy} has drifted from scripts/disk-guard.sh; redeploy it from the repo copy`,
    );
  }
});
