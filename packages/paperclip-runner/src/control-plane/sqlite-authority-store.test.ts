import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { promisify } from "node:util";
import { SqliteAuthorityStore } from "./sqlite-authority-store.js";
import { authorityInteger, type AuthorityRecord } from "./durable-authority-store.js";
import { defaultStorageRunnerBinary } from "./native-storage-command.js";

const execute = promisify(execFile);

const stores: SqliteAuthorityStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-authority-"));
  roots.push(root);
  await chmod(root, 0o700);
  const input = { path: join(root, "authority.sqlite"), binding: "company:session:runner:environment", create: true };
  const store = await SqliteAuthorityStore.open(input);
  stores.push(store);
  return { store, input };
}
const record = (id: string, sequence: string, text = id): AuthorityRecord => ({ epoch: "run-1", kind: "event", id, sequence, body: { text } });

it("retains unordered effect identities without consuming a lifetime sequence", async () => {
  const { store, input } = await fixture();
  expect(store.unorderedEffectReceipts).toBe(true);
  const old = { ...record("old-effect", "9223372036854775807"), kind: "effect" as const };
  const first = { ...record("new-effect-1", "0"), kind: "effect" as const };
  const second = { ...record("new-effect-2", "0"), kind: "effect" as const };
  const generation = await store.commit({ expectedGeneration: "0", state: { settled: true }, records: [old, first, second] });
  await store.close();
  const reopened = await SqliteAuthorityStore.open({ ...input, create: false }); stores.push(reopened);
  for (const receipt of [old, first, second]) {
    expect(await reopened.getSessionEffect(receipt.id)).toEqual(receipt);
    expect(await reopened.getRecord("run-1", "effect", receipt.id)).toEqual(receipt);
  }
  for (const conflicting of [{ ...first, body: { text: "changed" } }, { ...old, sequence: "0" }, { ...first, epoch: "run-2" }]) {
    await expect(reopened.commit({ expectedGeneration: generation, state: {}, records: [conflicting] })).rejects.toThrow("receipt_conflict");
  }
  expect(await reopened.load()).toEqual({ generation, state: { settled: true } });
});

it("commits current authority with exact receipts, and rejects stale writers", async () => {
  const { store, input } = await fixture();
  expect(await store.load()).toBeNull();
  await store.commit({ expectedGeneration: "0", state: { cursor: "1" }, records: [record("first", "1")] });
  await expect(store.commit({ expectedGeneration: "1", state: { cursor: "2" }, records: [record("second", "2"), record("first", "1", "conflicting")] })).rejects.toThrow("receipt_conflict");
  await expect(store.commit({ expectedGeneration: "1", state: { cursor: "2" }, records: [record("alias", "1")] })).rejects.toThrow("receipt_conflict");
  expect(await store.getRecord("run-1", "event", "second")).toBeNull();
  expect(await store.load()).toEqual({ generation: "1", state: { cursor: "1" } });
  await expect(store.commit({ expectedGeneration: "0", state: {}, records: [] })).rejects.toThrow("stale_authority");
  await store.close();
  const reopened = await SqliteAuthorityStore.open({ ...input, create: false });
  stores.push(reopened);
  expect(await reopened.getRecord("run-1", "event", "first")).toEqual(record("first", "1"));
  expect(await reopened.getRecord("run-2", "event", "first")).toBeNull();
  const proof = await SqliteAuthorityStore.open({ ...input, create: false, readOnly: true });
  stores.push(proof);
  expect(await proof.load()).toEqual(await reopened.load());
  await expect(proof.commit({ expectedGeneration: "1", state: {}, records: [] })).rejects.toThrow("proof readers cannot commit");
  await expect(SqliteAuthorityStore.open({ ...input, binding: "wrong-owner", create: false })).rejects.toThrow("binding");
});

it("keeps exact integers above Number.MAX_SAFE_INTEGER and pages by bytes", async () => {
  const { store } = await fixture();
  const first = "9007199254740993", next = "9007199254740994";
  const payload = "x".repeat(600_000);
  await store.commit({ expectedGeneration: "0", state: { cursor: next }, records: [record("first", first, payload), record("next", next, payload)] });
  const page = await store.readEvents("run-1", "0", 128, 1024 * 1024);
  expect(page.records.map((entry) => entry.sequence)).toEqual([first]);
  expect((await store.readEvents("run-1", page.nextAfter!, 128, 1024 * 1024)).records.map((entry) => entry.sequence)).toEqual([next]);
  expect(authorityInteger(first)).toBe(9007199254740993n);
  expect(() => authorityInteger("9007199254740993.0")).toThrow();
});

it("continues past the native revision boundary with exact proof and outstanding-work reads", async () => {
  const { store, input } = await fixture();
  await store.commit({ expectedGeneration: "0", state: { cursor: "1" }, records: [record("first", "1")], work: [
    { collection: "process-owner", id: "owner", expectedSha256: null, body: { phase: "spawned" } },
  ] });
  await store.close();
  const db = new DatabaseSync(input.path);
  try { db.prepare("UPDATE current_state SET generation=? WHERE key='authority'").run(9223372036854775807n); }
  finally { db.close(); }
  const active = await SqliteAuthorityStore.open({ ...input, create: false }); stores.push(active);
  const first = await active.commit({ expectedGeneration: "9223372036854775807", state: { cursor: "2" }, records: [record("second", "2")] });
  expect(first).toMatch(/^r:/);
  const second = await active.commit({ expectedGeneration: first, state: { cursor: "3" }, records: [] });
  expect(second).not.toBe(first);
  await expect(active.commit({ expectedGeneration: first, state: { stale: true }, records: [] })).rejects.toThrow("stale_authority");
  const proof = await SqliteAuthorityStore.open({ ...input, create: false, readOnly: true }); stores.push(proof);
  expect(await proof.load()).toEqual({ generation: second, state: { cursor: "3" } });
  expect(await proof.load()).toEqual(await active.load());
  expect(await proof.getRecord("run-1", "event", "first")).toEqual(record("first", "1"));
  expect((await proof.readWorkPage("process-owner", "", 128, second)).records.map(row => row.id)).toEqual(["owner"]);
  await expect(proof.readWorkPage("process-owner", "", 128, first)).rejects.toThrow("stale_authority");
  expect((await active.readEvents("run-1", "0", 128, 1024 * 1024)).records).toEqual([record("first", "1"), record("second", "2")]);
});

it("does not recreate a missing activated store", async () => {
  const { store, input } = await fixture();
  await store.close();
  await rm(input.path);
  await expect(SqliteAuthorityStore.open({ ...input, create: false })).rejects.toThrow("storage_unavailable");
});

it("partitions standalone history and preserves exact event/effect indexes after reopening", async () => {
  const { store, input } = await fixture();
  await store.close();
  const setup = new DatabaseSync(input.path);
  try {
    expect(setup.prepare("SELECT schema_version FROM store_binding").get()?.schema_version).toBe(2);
    setup.exec("UPDATE receipt_storage_config SET partition_bytes=32768");
  } finally { setup.close(); }
  const active = await SqliteAuthorityStore.open({ ...input, create: false }); stores.push(active);
  let generation = "0";
  const text = "history ".repeat(1024);
  for (let index = 1; index <= 64; index += 1) {
    generation = await active.commit({ expectedGeneration: generation, state: { latest: index }, records: [record(`event-${index}`, String(index), text),
      { epoch: "run-1", kind: "effect", id: `effect-${index}`, sequence: String(index), body: { accepted: index } }] });
  }
  await active.close();
  const { stdout } = await execute(defaultStorageRunnerBinary(), [
    "storage",
    "partitions",
    "--path",
    input.path,
    "--binding",
    input.binding,
    "--limit",
    "32",
  ], { env: {}, maxBuffer: 64 * 1024, timeout: 30_000, windowsHide: true });
  const partitionPage = JSON.parse(stdout) as {
    schema?: string;
    partitions?: unknown[];
  };
  expect(partitionPage.schema).toBe("paperclip.receipt-partitions.v1");
  expect(partitionPage.partitions?.length ?? 0).toBeGreaterThan(1);
  const reopened = await SqliteAuthorityStore.open({ ...input, create: false }); stores.push(reopened);
  expect(await reopened.load()).toEqual({ generation: "64", state: { latest: 64 } });
  expect(await reopened.getSessionEffect("effect-1")).toMatchObject({ epoch: "run-1", body: { accepted: 1 } });
  expect(await reopened.getRecord("run-1", "event", "event-1")).toEqual(record("event-1", "1", text));
  const page = await reopened.readEvents("run-1", "30", 8, 1024 * 1024);
  expect(page.records.map(record => record.sequence)).toEqual(["31", "32", "33", "34", "35", "36", "37", "38"]);
  await expect(reopened.commit({ expectedGeneration: "64", state: { wrong: true }, records: [{ epoch: "run-2", kind: "effect", id: "effect-1", sequence: "1", body: { accepted: 1 } }] })).rejects.toThrow("receipt_conflict");
  expect((await reopened.load())?.generation).toBe("64");
}, 60_000);

it("preserves retained version-1 controller files without silently replacing their authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-sqlite-authority-")); roots.push(root);
  const path = join(root, "authority.sqlite"), binding = "legacy-retained", body = '{"retained":true}';
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  try {
    db.exec("CREATE TABLE authority_binding(singleton INTEGER PRIMARY KEY,schema_version INTEGER,binding TEXT); CREATE TABLE authority_state(singleton INTEGER PRIMARY KEY,generation INTEGER,body TEXT,digest TEXT); CREATE TABLE authority_records(epoch TEXT,kind TEXT,id TEXT,sequence INTEGER,body TEXT,digest TEXT,PRIMARY KEY(epoch,kind,id),UNIQUE(epoch,kind,sequence)); CREATE UNIQUE INDEX authority_session_effect ON authority_records(id) WHERE kind='effect'");
    db.prepare("INSERT INTO authority_binding VALUES (1,1,?)").run(binding);
    db.prepare("INSERT INTO authority_state VALUES (1,7,?,?)").run(body, createHash("sha256").update(body).digest("hex"));
  } finally { db.close(); }
  const store = await SqliteAuthorityStore.open({ path, binding, create: false }); stores.push(store);
  expect(store.unorderedEffectReceipts).toBe(false);
  await expect(store.commit({ expectedGeneration: "7", state: {}, records: [{ ...record("effect", "0"), kind: "effect" }] })).rejects.toThrow("retained v1 store requires ordered effect receipts");
  expect(await store.load()).toEqual({ generation: "7", state: { retained: true } });
  await store.commit({ expectedGeneration: "7", state: { continued: true }, records: [record("legacy", "1")] });
  expect(await store.getRecord("run-1", "event", "legacy")).toEqual(record("legacy", "1"));
  await store.close();
  const check = new DatabaseSync(path, { readOnly: true });
  try { expect(check.prepare("SELECT schema_version FROM authority_binding").get()?.schema_version).toBe(1); }
  finally { check.close(); }
});

it("does not use an unfinished native backup as a current-state proof", async () => {
  const { store, input } = await fixture();
  await store.commit({ expectedGeneration: "0", state: { authority: true }, records: [] });
  await store.close();
  const db = new DatabaseSync(input.path);
  try { db.exec("CREATE TABLE backup_manifest(singleton INTEGER PRIMARY KEY,id TEXT,complete INTEGER); INSERT INTO backup_manifest VALUES(1,'unfinished',0)"); }
  finally { db.close(); }
  const proof = await SqliteAuthorityStore.open({ ...input, create: false, readOnly: true }); stores.push(proof);
  await expect(proof.load()).rejects.toThrow("backup is incomplete");
});

it("pages outstanding owners at an exact generation and retires only the exact row", async () => {
  const { store } = await fixture();
  const start = { collection: "process-owner" as const, id: "launch-1", expectedSha256: null, body: { phase: "spawned", processId: 9001 } };
  await store.commit({ expectedGeneration: "0", state: { owners: 1 }, records: [record("intent", "1")], work: [start] });
  const owner = (await store.getWork("process-owner", "launch-1"))!;
  expect((await store.readWorkPage("process-owner", "", 1, "1")).records).toEqual([owner]);
  await expect(store.commit({ expectedGeneration: "1", state: { owners: 0 }, records: [record("wrong", "2")], work: [{ ...start, expectedSha256: "0".repeat(64), body: null }] })).rejects.toThrow("stale_authority");
  expect(await store.getRecord("run-1", "event", "wrong")).toBeNull();
  expect(await store.getWork("process-owner", "launch-1")).toEqual(owner);
  await store.commit({ expectedGeneration: "1", state: { owners: 0 }, records: [record("retirement-proof", "2")], work: [{ ...start, expectedSha256: owner.sha256, body: null }] });
  expect(await store.getWork("process-owner", "launch-1")).toBeNull();
  await expect(store.readWorkPage("process-owner", "", 1, "1")).rejects.toThrow("stale_authority");
  expect((await store.readWorkPage("process-owner", "", 128, "2")).records).toEqual([]);
  expect(await store.getRecord("run-1", "event", "intent")).toEqual(record("intent", "1"));
});

it("read-only owner pages validate authority and reject a changed generation or corrupt root", async () => {
  const { store, input } = await fixture();
  await store.commit({ expectedGeneration: "0", state: { owners: 1 }, records: [], work: [{ collection: "process-owner", id: "owner-1", expectedSha256: null, body: { phase: "spawned" } }] });
  const reader = await SqliteAuthorityStore.open({ ...input, create: false, readOnly: true }); stores.push(reader);
  expect((await reader.readWorkPage("process-owner", "", 128, "1")).records).toHaveLength(1);
  await expect(reader.readWorkPage("process-owner", "", 128, "2")).rejects.toThrow("stale_authority");
  await reader.close(); await store.close();
  const db = new DatabaseSync(input.path);
  try { db.exec("UPDATE current_state SET digest=zeroblob(32) WHERE key='authority'"); } finally { db.close(); }
  const damaged = await SqliteAuthorityStore.open({ ...input, create: false, readOnly: true }); stores.push(damaged);
  await expect(damaged.readWorkPage("process-owner", "", 128, "1")).rejects.toThrow("digest mismatch");
});


it("separates renewable command ordering from immutable command identity", async () => {
  const { store, input } = await fixture();
  expect(store.commandEpochs).toBe(true);
  const receipts: AuthorityRecord[] = [undefined, randomUUID(), randomUUID()].map((sequenceEpoch, index) => ({
    ...record(`command-${index}`, "1"), kind: "command", ...(sequenceEpoch ? { sequenceEpoch } : {}),
  }));
  const generation = await store.commit({ expectedGeneration: "0", state: { current: receipts[2]!.sequenceEpoch }, records: receipts });
  await store.close();
  const reopened = await SqliteAuthorityStore.open({ ...input, create: false }); stores.push(reopened);
  for (const receipt of receipts) expect(await reopened.getRecord(receipt.epoch, "command", receipt.id)).toEqual(receipt);
  for (const record of [{ ...receipts[1]!, id: "alias" }, { ...receipts[0]!, sequenceEpoch: randomUUID() }]) {
    await expect(reopened.commit({ expectedGeneration: generation, state: {}, records: [record] })).rejects.toThrow("receipt_conflict");
  }
  expect((await reopened.load())?.generation).toBe(generation);
});
