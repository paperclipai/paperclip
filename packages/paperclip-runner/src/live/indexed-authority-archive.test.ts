import { nativeStorageCommand } from "../control-plane/native-storage-command.js";
import { authorityJson } from "../control-plane/durable-authority-store.js";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { finishIndexedRunnerArchive, prepareIndexedRunnerArchive, publishIndexedArchiveHead, readIndexedArchiveHead } from "./indexed-authority-archive.js";
import { readIndexedLocalState } from "../control-plane/indexed-local-state-reader.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { runnerdRecoveryInternals } from "./runnerd-codex-transport.js";

it("reopens the exact indexed controller after cold rotation without reading older epochs", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "indexed-cold-rotation-"));
  const controller = resolve(root, "control-plane"), runner = resolve(root, "runner");
  mkdirSync(controller, { mode: 0o700 }); mkdirSync(runner, { mode: 0o700 });
  const identity = { runnerInstanceId: "runner-test", environmentLeaseId: "environment-test", normalizedSessionId: "session-test", runId: "run-old", turnId: "turn-old", itemId: "item-old" };
  const desired = { ...identity, runId: "run-new", turnId: "turn-new", itemId: "item-new" };
  const store = await SqliteAuthorityStore.open({ path: resolve(controller, "authority.sqlite"), binding: JSON.stringify(identity), create: true });
  try {
    const core = await DurablePrpControlPlane.open({ stateDirectory: controller, identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}`, authorityStore: store });
    const state = structuredClone(core.store.state) as unknown as Record<string, unknown>;
    await store.close();
    const path = resolve(runner, "runner-state.sqlite");
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      writeFileSync(`${path}.lifetime`, "", { mode: 0o600 });
      db.exec("CREATE TABLE store_binding(singleton INTEGER PRIMARY KEY,schema_version INTEGER,binding TEXT); CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB)");
      db.prepare("INSERT INTO store_binding VALUES (1,1,'runner/session')").run();
      const bytes = Buffer.from(JSON.stringify({ ...identity, schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended", nextSourceSeq: 1, ackedSourceSeq: 0 }));
      db.prepare("INSERT INTO current_state VALUES ('runner',12,?,?)").run(bytes, createHash("sha256").update(bytes).digest());
    } finally { db.close(); }
    writeFileSync(resolve(runner, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.indexed.v1", binding: "runner/session" }), { mode: 0o600 });
    expect(await runnerdRecoveryInternals.rotateLocalAuthorityEpoch(root, state, desired)).toEqual(state);
    const head = readIndexedArchiveHead(resolve(root, "authority-epochs"));
    expect(head).not.toBeNull();
    // The legacy scan would select this newer, invalid archive first.
    const unrelated = resolve(root, "authority-epochs", "unrelated", "control-plane");
    mkdirSync(unrelated, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(unrelated, "control-plane-state.json"), "not valid authority", { mode: 0o600 });
    expect(await runnerdRecoveryInternals.latestArchivedControlPlaneState(root, desired)).toEqual(state);
    await expect(runnerdRecoveryInternals.latestArchivedControlPlaneState(root, { ...desired, normalizedSessionId: "wrong-session" })).rejects.toThrow("archive_conflict");
    expect(await runnerdRecoveryInternals.rotateLocalAuthorityEpoch(root, state, desired)).toEqual(state);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("routes interrupted cold rotation directly despite unavailable old archives", () => {
  const root = mkdtempSync(resolve(tmpdir(), "indexed-archive-head-"));
  const archive = resolve(root, `epoch-${"a".repeat(24)}`);
  mkdirSync(archive, { mode: 0o700 });
  try {
    expect(readIndexedArchiveHead(root)).toBeNull();
    publishIndexedArchiveHead(archive);
    // Unrelated retained epochs must never be enumerated or read to resume.
    for (let index = 0; index < 128; index++) {
      symlinkSync(resolve(root, "unavailable-volume", String(index)), resolve(root, `old-${index}`));
    }
    expect(readIndexedArchiveHead(root)).toBe(archive);
    const next = resolve(root, `epoch-${"b".repeat(24)}`);
    mkdirSync(next, { mode: 0o700 });
    publishIndexedArchiveHead(next);
    rmSync(archive, { recursive: true });
    expect(readIndexedArchiveHead(root)).toBe(next);
    rmSync(next, { recursive: true });
    expect(() => readIndexedArchiveHead(root)).toThrow();
    // Never treat a broken pointer as legacy state and fall back to old epochs.
    rmSync(resolve(root, "current-archive.json"));
    symlinkSync(resolve(root, "missing"), resolve(root, "current-archive.json"));
    expect(() => readIndexedArchiveHead(root)).toThrow("archive_unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  [1, "12"], [2, "12"], [2, "9223372036854775807"],
  [2, "r:59365b32-c44d-46f2-8550-a7b5bba1bd68"],
] as const)("recovers an interrupted schema %s SQLite archive at revision %s without scanning or copying its history", async (schema, generation) => {
  const root = mkdtempSync(resolve(tmpdir(), "indexed-archive-"));
  const runner = resolve(root, "runner"), archive = resolve(root, "archive");
  mkdirSync(runner, { mode: 0o700 }); mkdirSync(archive, { mode: 0o700 });
  mkdirSync(resolve(root, "control-plane"), { mode: 0o700 });
  const path = resolve(runner, "runner-state.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
      writeFileSync(`${path}.lifetime`, "", { mode: 0o600 });
  db.exec("CREATE TABLE store_binding(singleton INTEGER PRIMARY KEY,schema_version INTEGER,binding TEXT); CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB); CREATE TABLE receipts(key TEXT PRIMARY KEY,bytes BLOB)");
  db.prepare("INSERT INTO store_binding VALUES (1,?,'runner/session')").run(schema);
  if (schema === 2) db.exec("CREATE TABLE receipt_prepare(singleton INTEGER PRIMARY KEY,state_key TEXT,generation INTEGER,body BLOB,digest BLOB)");
  const bytes = Buffer.from(JSON.stringify({ lifecycle: "suspended", nextSourceSeq: 2, ackedSourceSeq: 1 }));
  db.prepare("INSERT INTO current_state VALUES ('runner',?,?,?)").run(generation.startsWith("r:") ? generation : BigInt(generation), bytes, createHash("sha256").update(bytes).digest());
  db.prepare("INSERT INTO receipts VALUES ('ancient',?)").run(Buffer.from("original outcome"));
  db.close();
  if (schema === 2) {
    const shards = resolve(runner, "runner-state.sqlite.receipts");
    mkdirSync(shards, { mode: 0o700 });
    writeFileSync(resolve(shards, "partition-fixture"), "immutable receipt evidence", { mode: 0o600 });
  }
  const routing = resolve(runner, "runner-state.sqlite.routing");
  mkdirSync(routing, { mode: 0o700 });
  writeFileSync(resolve(routing, "routing-fixture"), "immutable routing evidence", { mode: 0o600 });
  writeFileSync(resolve(runner, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.indexed.v1", binding: "runner/session" }), { mode: 0o600 });
  try {
    await prepareIndexedRunnerArchive(runner, archive);
    await expect(finishIndexedRunnerArchive(runner, archive)).rejects.toThrow("controller_missing");
    renameSync(resolve(root, "control-plane"), resolve(archive, "control-plane"));
    // Simulate loss of the controller after the DB rename and before locator publication.
    renameSync(path, resolve(archive, "runner-state.sqlite"));
    expect(await finishIndexedRunnerArchive(runner, archive)).toBe(true);
    expect(existsSync(resolve(runner, "runner-state.json"))).toBe(false);
    expect(existsSync(resolve(archive, "runner-state.sqlite.routing", "routing-fixture"))).toBe(true);
    expect(existsSync(resolve(runner, "runner-state.sqlite.routing"))).toBe(false);
    if (schema === 2) {
      expect(existsSync(resolve(archive, "runner-state.sqlite.receipts", "partition-fixture"))).toBe(true);
      expect(existsSync(resolve(runner, "runner-state.sqlite.receipts"))).toBe(false);
    }
    expect(await finishIndexedRunnerArchive(runner, archive)).toBe(true);
    expect(await readIndexedLocalState(resolve(archive, "runner-state.json"))).toMatchObject({ generation, state: { lifecycle: "suspended", outbox: [] } });
    const restored = new DatabaseSync(resolve(archive, "runner-state.sqlite"), { readOnly: true });
    try { expect(Buffer.from(restored.prepare("SELECT bytes FROM receipts WHERE key='ancient'").get()!.bytes as Uint8Array).toString()).toBe("original outcome"); }
    finally { restored.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fences standalone controller archive against an open storage owner and stale authority", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "indexed-controller-archive-"));
  const controller = resolve(root, "controller"), target = resolve(root, "archived");
  mkdirSync(controller, { mode: 0o700 });
  const identity = { runnerInstanceId: "runner-test", environmentLeaseId: "environment-test", normalizedSessionId: "session-test", runId: "run-old", turnId: "turn-old", itemId: "item-old" };
  const store = await SqliteAuthorityStore.open({ path: resolve(controller, "authority.sqlite"), binding: JSON.stringify(identity), create: true });
  try {
    const core = await DurablePrpControlPlane.open({ stateDirectory: controller, identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}`, authorityStore: store });
    const storedState = (await store.load())!.state;
    const digest = createHash("sha256").update(authorityJson(storedState)).digest("hex");
    const command = ["archive-controller", "--directory", controller, "--destination", target, "--digest", digest];
    await expect(nativeStorageCommand(command)).rejects.toThrow("open connection");
    await store.close();
    await expect(nativeStorageCommand([...command.slice(0, -1), "0".repeat(64)])).rejects.toThrow("authority changed");
    expect(existsSync(controller)).toBe(true);
    await nativeStorageCommand(command);
    expect(existsSync(controller)).toBe(false);
    expect(existsSync(resolve(target, "authority.sqlite"))).toBe(true);
    const reopened = await SqliteAuthorityStore.open({ path: resolve(target, "authority.sqlite"), binding: JSON.stringify(identity), create: false });
    try { expect((await reopened.load())?.state).toEqual(storedState); } finally { await reopened.close(); }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
