import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readIndexedLocalState, suspendIndexedRunnerState } from "./indexed-local-state-reader.js";

it.each([1, 2])("schema %s seals only the verified empty runner generation without replacing its locator or receipts", async (schema) => {
  const root = mkdtempSync(join(tmpdir(), "runner-indexed-proof-"));
  const path = join(root, "runner-state.json");
  const database = join(root, "runner-state.sqlite");
  const locator = JSON.stringify({ schema: "paperclip.runner.durable.state.indexed.v1", binding: "runner/one/session" });
  writeFileSync(path, locator, { mode: 0o600 });
  const db = new DatabaseSync(database);
  chmodSync(database, 0o600);
  writeFileSync(`${database}.lifetime`, "", { mode: 0o600 });
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE store_binding(singleton INTEGER PRIMARY KEY,schema_version INTEGER,binding TEXT); CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB); CREATE TABLE receipts(key TEXT PRIMARY KEY,bytes BLOB)");
    db.prepare("INSERT INTO store_binding VALUES (1,?,?)").run(schema, "runner/one/session");
    if (schema === 2) db.exec("CREATE TABLE receipt_prepare(singleton INTEGER PRIMARY KEY,state_key TEXT,generation INTEGER,body BLOB,digest BLOB)");
    db.prepare("INSERT INTO receipts VALUES ('ancient',?)").run(Buffer.from("original outcome"));
    const activeInput = schema === 2 ? "界".repeat(500_000) : "small";
    const write = (generation: number | bigint | string, ackedSourceSeq: number) => {
      const body = Buffer.from(JSON.stringify({ lifecycle: "ready", nextSourceSeq: 101, ackedSourceSeq, pendingTerminalDelivery: null, activeInput }));
      db.prepare("INSERT OR REPLACE INTO current_state VALUES ('runner',?,?,?)").run(generation, body, createHash("sha256").update(body).digest());
    };
    write(1, 100);
    expect(await readIndexedLocalState(path)).toMatchObject({ generation: "1", state: { outbox: [], lifecycle: "ready", activeInput } });
    rmSync(`${database}.lifetime`);
    await expect(readIndexedLocalState(path)).rejects.toThrow();
    expect(existsSync(`${database}.lifetime`)).toBe(false);
    const foreign = join(root, "foreign-lifetime");
    writeFileSync(foreign, "foreign", { mode: 0o600 });
    symlinkSync(foreign, `${database}.lifetime`);
    await expect(readIndexedLocalState(path)).rejects.toThrow();
    expect(readFileSync(foreign, "utf8")).toBe("foreign");
    rmSync(`${database}.lifetime`);
    writeFileSync(`${database}.lifetime`, "", { mode: 0o600 });
    if (schema === 2) {
      db.exec("CREATE TABLE backup_manifest(singleton INTEGER PRIMARY KEY,id TEXT,complete INTEGER); INSERT INTO backup_manifest VALUES(1,'backup',0)");
      await expect(readIndexedLocalState(path)).rejects.toThrow(/incomplete backup/);
      await expect(suspendIndexedRunnerState(path, "1")).rejects.toThrow("backup_incomplete");
      expect(db.prepare("SELECT generation FROM current_state").get()!.generation).toBe(1);
      db.exec("UPDATE backup_manifest SET complete=1");
      db.exec("INSERT INTO receipt_prepare SELECT 1,key,generation,bytes,digest FROM current_state");
      expect(await readIndexedLocalState(path)).toMatchObject({ generation: "1", state: { lifecycle: "ready" } });
      await suspendIndexedRunnerState(path, "1");
      expect(db.prepare("SELECT generation FROM receipt_prepare").get()!.generation).toBe(2);
      expect(await readIndexedLocalState(path)).toMatchObject({ generation: "2", state: { lifecycle: "suspended" } });
      db.exec("UPDATE receipt_prepare SET generation=1");
      await expect(readIndexedLocalState(path)).rejects.toThrow(/conflicting prepared receipts/);
      db.exec("DELETE FROM receipt_prepare");
    }
    write(2, 100);
    await expect(suspendIndexedRunnerState(path, "1")).rejects.toThrow("stale_or_unsettled");
    await suspendIndexedRunnerState(path, "2");
    expect(await readIndexedLocalState(path)).toMatchObject({ generation: "3", state: { outbox: [], lifecycle: "suspended" } });
    expect(readFileSync(path, "utf8")).toBe(locator);
    expect(Buffer.from(db.prepare("SELECT bytes FROM receipts WHERE key='ancient'").get()!.bytes as Uint8Array).toString()).toBe("original outcome");
    write(9223372036854775807n, 100);
    expect((await readIndexedLocalState(path)).generation).toBe("9223372036854775807");
    await suspendIndexedRunnerState(path, "9223372036854775807");
    const opaque = (await readIndexedLocalState(path)).generation;
    expect(opaque).toMatch(/^r:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await expect(suspendIndexedRunnerState(path, "9223372036854775807")).rejects.toThrow("stale_or_unsettled");
    await suspendIndexedRunnerState(path, opaque);
    expect((await readIndexedLocalState(path)).generation).not.toBe(opaque);
    expect(Buffer.from(db.prepare("SELECT bytes FROM receipts WHERE key='ancient'").get()!.bytes as Uint8Array).toString()).toBe("original outcome");
    write(4, 99);
    expect((await readIndexedLocalState(path)).state.outbox).toEqual([{ indexedPending: true }]);
    await expect(suspendIndexedRunnerState(path, "4")).rejects.toThrow("stale_or_unsettled");
    db.exec("UPDATE current_state SET digest=zeroblob(32)");
    await expect(readIndexedLocalState(path)).rejects.toThrow(/digest.*mismatch/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("reaps its native reader before releasing a failed or timed-out read", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-native-reader-owner-"));
  try {
    const binary = join(root, "reader");
    writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = process.argv.at(-1);\nfs.writeFileSync(path + '.pid', String(process.pid));\nprocess.stdout.write(path.endsWith('invalid') ? 'invalid\\n' + 'x'.repeat(2 * 1024 * 1024) : JSON.stringify({schema:'paperclip.indexed-inspection.v1',byteLength:1,sha256:'a'.repeat(64)})+'\\n');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    for (const kind of ["invalid", "stalled"]) {
      const path = join(root, kind);
      await expect(readIndexedLocalState(path, { runnerBinary: binary, timeoutMs: 2000 })).rejects.toThrow(kind === "invalid" ? "invalid_or_incomplete" : "read_timeout");
      const pid = Number(readFileSync(`${path}.pid`, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await expect(readIndexedLocalState(join(root, "absent"), { runnerBinary: join(root, "missing-binary") })).rejects.toThrow("ENOENT");
    // All ownership/admission slots are available after failures.
    const failed = await Promise.allSettled(Array.from({ length: 4 }, () => readIndexedLocalState(join(root, "invalid"), { runnerBinary: binary })));
    expect(failed.every(result => result.status === "rejected" && String(result.reason).includes("invalid_or_incomplete"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
