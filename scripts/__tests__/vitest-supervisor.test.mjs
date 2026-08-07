import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  VitestInvocationSupervisor,
  acquireHostSlot,
  diagnoseStableInvocations,
  findRootReferences,
  listTaggedProcesses,
  readLinuxProcessIdentity,
  reapStaleStableInvocations,
  resolveTestTempParent,
  signalProcessIdentity,
} from "../vitest-supervisor.mjs";

const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stableRunner = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");

async function withTempParent(t) {
  const parent = await fs.mkdtemp(path.join(scratchParent, "pcvt-supervisor-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return parent;
}

function supervisor(parent, label, overrides = {}) {
  return new VitestInvocationSupervisor({
    label,
    tempParent: parent,
    graceMs: 300,
    disableCgroup: true,
    ...overrides,
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("configured PAPERCLIP_TEST_TMPDIR is preferred and created", async (t) => {
  const parent = await withTempParent(t);
  const configured = path.join(parent, "configured");
  const resolved = await resolveTestTempParent({ PAPERCLIP_TEST_TMPDIR: configured, TMPDIR: "/unused" });
  assert.equal(resolved.parent, configured);
  assert.equal(resolved.source, "PAPERCLIP_TEST_TMPDIR");
});

test("an unsafe configured temp parent falls back to an absolute TMPDIR", async (t) => {
  const parent = await withTempParent(t);
  const resolved = await resolveTestTempParent({ PAPERCLIP_TEST_TMPDIR: "relative/path", TMPDIR: parent });
  assert.equal(resolved.parent, parent);
  assert.equal(resolved.source, "TMPDIR");
});

test("successful and nonzero children both leave no root", async (t) => {
  const parent = await withTempParent(t);
  for (const exitCode of [0, 7]) {
    const run = supervisor(parent, `exit-${exitCode}`);
    const result = await run.run(process.execPath, ["-e", `process.exit(${exitCode})`]);
    assert.equal(result.code, exitCode);
    const root = run.root;
    const cleanup = await run.cleanup();
    assert.equal(cleanup.removed, true);
    assert.equal(run.containmentMode, "posix-process-group+tagged-proc");
    await assert.rejects(fs.access(root));
  }
});

test("child spawn errors still clean the invocation root", async (t) => {
  const parent = await withTempParent(t);
  const run = supervisor(parent, "spawn-error");
  await assert.rejects(run.run(path.join(parent, "missing-command"), []), /ENOENT/);
  const root = run.root;
  await run.cleanup();
  await assert.rejects(fs.access(root));
});

test("explicit failed-artifact retention stays bounded", async (t) => {
  const parent = await withTempParent(t);
  for (let index = 0; index < 2; index += 1) {
    const run = supervisor(parent, `retained-${index}`);
    await run.run(process.execPath, ["-e", "process.exit(1)"]);
    const cleanup = await run.cleanup({ retainReason: "test_failure", retainedLimit: 1 });
    assert.equal(cleanup.removed, false);
  }
  const retained = (await fs.readdir(parent)).filter((entry) => entry.startsWith("pcvt-retained-"));
  assert.equal(retained.length, 1);
});

test("timeout drains a cooperative detached descendant with TERM only", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'})`,
    "child.unref()",
    "process.on('SIGTERM',()=>process.exit(0))",
    "setInterval(()=>{},1000)",
  ].join(";");
  const run = supervisor(parent, "cooperative-timeout", { timeoutMs: 120, graceMs: 1_000 });
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.stopReason, "timeout_after_120ms");
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
  assert.equal(run.killCount, 0);
});

test("SIGTERM-ignoring detached descendants are force-killed", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'})`,
    "child.unref()",
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  const run = supervisor(parent, "forced-timeout", { timeoutMs: 120, graceMs: 150 });
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.stopReason, "timeout_after_120ms");
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
  assert.ok(run.killCount >= 1);
});

test("a descendant process budget breach fails with scoped diagnostics", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'})`,
    "child.unref()",
    "setInterval(()=>{},1000)",
  ].join(";");
  const run = supervisor(parent, "budget-owner.test.ts", { processBudget: 1, graceMs: 200 });
  await assert.rejects(
    run.run(process.execPath, ["-e", parentCode]),
    new RegExp(`Process budget exceeded for invocation ${run.invocationId} \\(budget-owner\\.test\\.ts\\)`),
  );
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
});

test("a detached grandchild is reaped after its direct parent exits", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'})`,
    "child.unref()",
  ].join(";");
  const run = supervisor(parent, "detached-grandchild");
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.code, 0);
  assert.ok((await run.ownedProcesses()).length >= 1);
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
});

test("an untagged process-group descendant is reaped after its parent exits", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{env:{},stdio:'ignore'})`,
    "child.unref()",
  ].join(";");
  const run = supervisor(parent, "untagged-process-group-descendant");
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.code, 0);
  const owned = await run.ownedProcesses();
  assert.equal(owned.length, 1);
  assert.equal(owned[0].processGroupId, run.processGroupId);
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
});

test("an observed detached descendant is reaped after losing its parent and tag", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,env:{},stdio:'ignore'})`,
    "child.unref()",
    "setTimeout(()=>process.exit(0),500)",
  ].join(";");
  const run = supervisor(parent, "observed-detached-descendant");
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.code, 0);
  const owned = await run.ownedProcesses();
  assert.equal(owned.length, 1);
  assert.notEqual(owned[0].processGroupId, run.processGroupId);
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
});

test("a root-scoped detached descendant is reaped without an invocation tag", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const childCode = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,env:{TMPDIR:process.env.TMPDIR},stdio:'ignore'})`,
    "child.unref()",
  ].join(";");
  const run = supervisor(parent, "root-scoped-detached-descendant");
  const result = await run.run(process.execPath, ["-e", parentCode]);
  assert.equal(result.code, 0);
  const owned = await run.ownedProcesses();
  assert.equal(owned.length, 1);
  assert.notEqual(owned[0].processGroupId, run.processGroupId);
  const cleanup = await run.cleanup();
  assert.equal(cleanup.survivors.length, 0);
  assert.equal(cleanup.removed, true);
});

test("concurrent invocation boundaries cannot signal one another", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const code = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const first = supervisor(parent, "concurrent-first");
  const second = supervisor(parent, "concurrent-second");
  const firstRun = first.run(process.execPath, ["-e", code]);
  const secondRun = second.run(process.execPath, ["-e", code]);
  await waitFor(() => first.child?.pid && second.child?.pid);
  first.requestStop("test_stop_first");
  await firstRun;
  await first.cleanup();
  assert.ok((await second.ownedProcesses()).length >= 1);
  second.requestStop("test_stop_second");
  await secondRun;
  await second.cleanup();
});

test("PID identity mismatch fails closed", { skip: process.platform !== "linux" }, async () => {
  const identity = await readLinuxProcessIdentity(process.pid);
  assert.ok(identity);
  const outcome = await signalProcessIdentity({ ...identity, startTime: `${identity.startTime}-reused` }, "SIGTERM");
  assert.equal(outcome, "identity_mismatch");
});

test("active cwd guard prevents premature root deletion", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const run = supervisor(parent, "cwd-guard");
  await run.initialize();
  const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: run.root,
    stdio: "ignore",
  });
  t.after(() => holder.kill("SIGKILL"));
  await waitFor(async () => (await findRootReferences(run.root)).some((reference) => reference.pid === holder.pid));
  await assert.rejects(run.cleanup({ retainReason: "test_failure" }), /active_root_reference/);
  assert.equal(run.root.startsWith(path.join(parent, "pcvt-retained-")), false);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  const cleanup = await run.cleanup();
  assert.equal(cleanup.removed, true);
});

test("an invariant failure without a guardian keeps its recovery record", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const run = supervisor(parent, "unguarded-cwd-reference");
  await run.initialize();
  await run.stopGuardian();
  const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: run.root,
    stdio: "ignore",
  });
  t.after(() => holder.kill("SIGKILL"));
  await waitFor(async () => (await findRootReferences(run.root)).some((reference) => reference.pid === holder.pid));
  await assert.rejects(run.cleanup(), /active_root_reference/);
  await fs.access(run.registryPath);
  const report = await diagnoseStableInvocations({ env: { PAPERCLIP_TEST_TMPDIR: parent } });
  assert.ok(report.invocations.some((invocation) => invocation.invocationId === run.invocationId));
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  const cleanup = await run.cleanup();
  assert.equal(cleanup.removed, true);
  await assert.rejects(fs.access(run.registryPath));
});

test("cleanup waits for transient root references to drain", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const run = supervisor(parent, "transient-cwd-reference", { graceMs: 1_000 });
  await run.initialize();
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),150)"], {
    cwd: run.root,
    stdio: "ignore",
  });
  t.after(() => holder.kill("SIGKILL"));
  await waitFor(async () => (await findRootReferences(run.root)).some((reference) => reference.pid === holder.pid));
  const cleanup = await run.cleanup();
  assert.equal(cleanup.removed, true);
  assert.deepEqual(cleanup.references, []);
});

test("host-wide slots enforce the configured cap", async (t) => {
  const parent = await withTempParent(t);
  const env = { PAPERCLIP_TEST_CONTROL_DIR: path.join(parent, "control") };
  const first = await acquireHostSlot({ invocationId: "slot-first", env, cap: 1, waitMs: 1_000 });
  await assert.rejects(
    acquireHostSlot({ invocationId: "slot-second", env, cap: 1, waitMs: 150 }),
    /host slot/,
  );
  await first.release();
  const second = await acquireHostSlot({ invocationId: "slot-second", env, cap: 1, waitMs: 1_000 });
  await second.release();
});

test("concurrent stale-slot reapers cannot remove a replacement owner", async (t) => {
  const parent = await withTempParent(t);
  const control = path.join(parent, "control");
  const slot = path.join(control, "slot-0");
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(
    path.join(slot, "owner.json"),
    `${JSON.stringify({ invocationId: "stale", pid: 2_000_000_000, startTime: "missing" })}\n`,
  );
  const env = { PAPERCLIP_TEST_CONTROL_DIR: control };
  const attempts = await Promise.allSettled([
    acquireHostSlot({ invocationId: "replacement-first", env, cap: 1, waitMs: 300 }),
    acquireHostSlot({ invocationId: "replacement-second", env, cap: 1, waitMs: 300 }),
  ]);
  const acquired = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /host slot/);
  await acquired[0].value.release();
});

test("a reaper lock with an owner write in flight fails closed", async (t) => {
  const parent = await withTempParent(t);
  const control = path.join(parent, "control");
  const slot = path.join(control, "slot-0");
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(
    path.join(slot, "owner.json"),
    `${JSON.stringify({ invocationId: "stale", pid: 2_000_000_000, startTime: "missing" })}\n`,
  );
  await fs.mkdir(path.join(control, ".slot-0-reaper"));
  await assert.rejects(
    acquireHostSlot({
      invocationId: "replacement",
      env: { PAPERCLIP_TEST_CONTROL_DIR: control },
      cap: 1,
      waitMs: 150,
    }),
    /host slot/,
  );
  assert.equal(JSON.parse(await fs.readFile(path.join(slot, "owner.json"), "utf8")).invocationId, "stale");
});

test("an abandoned reaper lock is quarantined before capacity is recovered", async (t) => {
  const parent = await withTempParent(t);
  const control = path.join(parent, "control");
  const slot = path.join(control, "slot-0");
  const reaperLock = path.join(control, ".slot-0-reaper");
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(
    path.join(slot, "owner.json"),
    `${JSON.stringify({ invocationId: "stale", pid: 2_000_000_000, startTime: "missing" })}\n`,
  );
  await fs.mkdir(reaperLock);
  await fs.writeFile(
    path.join(reaperLock, "owner.json"),
    `${JSON.stringify({
      token: "abandoned-token",
      pid: 2_000_000_000,
      startTime: "missing",
    })}\n`,
  );
  const replacement = await acquireHostSlot({
    invocationId: "replacement",
    env: { PAPERCLIP_TEST_CONTROL_DIR: control },
    cap: 1,
    waitMs: 1_000,
  });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(slot, "owner.json"), "utf8")).invocationId,
    "replacement",
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(`${reaperLock}-abandoned-abandoned-token`, "owner.json"), "utf8"),
    ).token,
    "abandoned-token",
  );
  await replacement.release();
});

test("an abandoned incomplete reaper lock is recovered after its write window", async (t) => {
  const parent = await withTempParent(t);
  const control = path.join(parent, "control");
  const slot = path.join(control, "slot-0");
  const reaperLock = path.join(control, ".slot-0-reaper");
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(
    path.join(slot, "owner.json"),
    `${JSON.stringify({ invocationId: "stale", pid: 2_000_000_000, startTime: "missing" })}\n`,
  );
  await fs.mkdir(reaperLock);
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(reaperLock, old, old);
  const replacement = await acquireHostSlot({
    invocationId: "replacement",
    env: { PAPERCLIP_TEST_CONTROL_DIR: control },
    cap: 1,
    waitMs: 1_000,
  });
  const tombstone = (await fs.readdir(control)).find((entry) =>
    entry.startsWith(".slot-0-reaper-abandoned-"),
  );
  assert.ok(tombstone);
  assert.match(await fs.readFile(path.join(control, tombstone, "tombstone"), "utf8"), /\S/);
  await replacement.release();
});

test("stale-root recovery only reaps an empty unreferenced dead-runner record", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const run = supervisor(parent, "stale-recovery");
  await run.initialize();
  await run.stopGuardian();
  const record = JSON.parse(await fs.readFile(run.registryPath, "utf8"));
  await fs.writeFile(
    run.registryPath,
    `${JSON.stringify({ ...record, runnerPid: 2_000_000_000, runnerStartTime: "missing" })}\n`,
  );
  const report = await reapStaleStableInvocations({ env: { PAPERCLIP_TEST_TMPDIR: parent } });
  assert.deepEqual(report.reaped, [run.invocationId]);
  assert.deepEqual(report.refused, []);
  await assert.rejects(fs.access(run.root));
});

test("diagnostics redact secret-bearing command arguments", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const secret = "super-secret-token-value";
  const run = supervisor(parent, "redaction-check");
  const running = run.run(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--token", secret]);
  try {
    await waitFor(() => run.child?.pid);
    const report = await diagnoseStableInvocations({ env: { PAPERCLIP_TEST_TMPDIR: parent } });
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    run.requestStop("redaction_test_done");
    await running;
    await run.cleanup();
  }
});

test("parent SIGTERM drains the active boundary and does not launch the next suite", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const child = spawn(
    process.execPath,
    [stableRunner, "--mode", "serialized", "--shard-index", "0", "--shard-count", "64"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERCLIP_TEST_TMPDIR: parent,
        PAPERCLIP_TEST_CONTROL_DIR: path.join(parent, "control"),
        PAPERCLIP_TEST_HOST_CAP: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let sentSignal = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!sentSignal && stdout.includes('"event":"vitest_invocation_start"')) {
      sentSignal = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 143, signal: null }, stderr);
  assert.equal((stdout.match(/"event":"vitest_invocation_start"/g) ?? []).length, 1, stdout);
  assert.equal((stdout.match(/"event":"vitest_invocation_cleanup"/g) ?? []).length, 1, stdout);
  assert.match(stdout, /"rootRemoved":true/);
  const roots = (await fs.readdir(parent)).filter((entry) => entry.startsWith("pcvt-") && !entry.startsWith("pcvt-retained-"));
  assert.deepEqual(roots, []);
});

test("the guardian cleans descendants and roots after uncatchable parent SIGKILL", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  const child = spawn(
    process.execPath,
    [stableRunner, "--mode", "serialized", "--shard-index", "0", "--shard-count", "64"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERCLIP_TEST_TMPDIR: parent,
        PAPERCLIP_TEST_CONTROL_DIR: path.join(parent, "control"),
        PAPERCLIP_TEST_HOST_CAP: "1",
        PAPERCLIP_TEST_GRACE_MS: "500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let invocationId = null;
  let tempRoot = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n").find((candidate) => candidate.includes('"event":"vitest_invocation_start"'));
    if (!line || invocationId) return;
    const record = JSON.parse(line.slice(line.indexOf("{")));
    invocationId = record.invocationId;
    tempRoot = record.tempRoot;
    child.kill("SIGKILL");
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
  assert.ok(invocationId && tempRoot, stdout);
  await waitFor(async () => {
    const rootGone = await fs.access(tempRoot).then(() => false, () => true);
    return rootGone && (await listTaggedProcesses(invocationId)).length === 0;
  }, 10_000);
  await assert.rejects(fs.access(tempRoot));
});

test("twenty repeated contained runs return roots to baseline", { skip: process.platform !== "linux" }, async (t) => {
  const parent = await withTempParent(t);
  for (let index = 0; index < 20; index += 1) {
    const run = supervisor(parent, `stress-${index}`);
    const result = await run.run(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(result.code, 0);
    await run.cleanup();
  }
  const roots = (await fs.readdir(parent)).filter((entry) => entry.startsWith("pcvt-"));
  assert.deepEqual(roots, []);
});
