import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageRunnerBinary } from "./stage-runner-binary.mjs";

async function withOwnedChildren(root, action) {
  const owned = [];
  const start = (command, args) => {
    const child = spawn(command, args, { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
    // close follows both exit and spawn error. A failed second spawn must not
    // interrupt retirement of the first still-running executable.
    const closed = new Promise(resolve => child.once("close", resolve));
    const spawned = once(child, "spawn");
    void spawned.catch(() => {});
    owned.push({ child, closed });
    return { child, spawned, closed };
  };
  try { return await action(start); }
  finally {
    try {
      const results = await Promise.allSettled(owned.map(async ({ child, closed }) => {
        if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Owned test child cleanup failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("atomically publishes while the previous executable is running", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-test-"));
  const destination = path.join(root, "paperclip-runnerd");
  await withOwnedChildren(root, async start => {
    await stageRunnerBinary("/bin/sleep", destination);
    const previous = await stat(destination);
    const old = start(destination, ["30"]);
    await old.spawned;
    await stageRunnerBinary("/bin/sleep", destination);
    const published = await stat(destination);
    assert.notEqual(published.ino, previous.ino);
    assert.equal(published.mode & 0o777, 0o755);
    assert.equal(old.child.exitCode, null);
    assert.equal(old.child.signalCode, null);
    assert.deepEqual(await readdir(root), ["paperclip-runnerd"]);
    const next = start(destination, ["0"]);
    await next.spawned; await next.closed;
    assert.equal(next.child.exitCode, 0);
  });
});

test("a second spawn error still retires the live old child and removes its fixture", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-spawn-failure-"));
  let old;
  await assert.rejects(withOwnedChildren(root, async start => {
    old = start("/bin/sleep", ["30"]); await old.spawned;
    const failed = start(path.join(root, "missing-executable"), []);
    await failed.spawned;
  }), { code: "ENOENT" });
  assert.notEqual(old.child.signalCode, null);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("failed preparation preserves the published bytes and mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-failure-"));
  const destination = path.join(root, "paperclip-runnerd");
  try {
    await writeFile(destination, "previous build", { mode: 0o755 });
    const before = await stat(destination);
    await assert.rejects(stageRunnerBinary(path.join(root, "absent-source"), destination), { code: "ENOENT" });
    assert.equal(await readFile(destination, "utf8"), "previous build");
    const after = await stat(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(await readdir(root), ["paperclip-runnerd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
