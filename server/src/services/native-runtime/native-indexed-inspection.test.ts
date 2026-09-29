import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { inspectRemoteIndexedState } from "./native-indexed-inspection.js";
import { loopbackCheckpointDuplexRunner } from "./native-checkpoint-transfer.test-support.js";
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";

const snapshot = { state: { lifecycle: "ready", outbox: [{ indexedPending: true }], activeInput: "界".repeat(500_000) },
  generation: "9007199254740992", stateDigest: "a".repeat(64), preparation: null };
function frames() {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const rows: Record<string, unknown>[] = [{ schema: "paperclip.indexed-inspection.v1", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  for (let start = 0; start < bytes.length; start += 192 * 1024) rows.push({ index: rows.length - 1, bytes: bytes.subarray(start, start + 192 * 1024).toString("base64") });
  rows.push({ complete: true }); return rows;
}
function runner(rows: Record<string, unknown>[], exit = { exitCode: 0, transportClosed: false }, hold = false) {
  const wire = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const stop = vi.fn(), close = vi.fn(async () => {}), execute = vi.fn();
  const openDuplexChannel = vi.fn(async () => ({
    stop, close, write() {},
    onData(callback: (bytes: Buffer) => void) {
      if (!hold) queueMicrotask(() => {
        // Fragment JSON, UTF-8 base64 and headers at arbitrary byte boundaries.
        for (let start = 0; start < wire.length; start += 7919) callback(wire.subarray(start, start + 7919));
      });
    },
    onExit(callback: (value: typeof exit) => void) { if (!hold) queueMicrotask(() => callback(exit)); },
  }));
  return { runner: { execute, openDuplexChannel } as CommandManagedRuntimeRunner, stop, close, execute, openDuplexChannel };
}
const inspect = (fixture: ReturnType<typeof runner>, timeoutMs?: number) => inspectRemoteIndexedState({ runner: fixture.runner, runnerBinary: "/private/runnerd", path: "/private/runner/runner-state.json", timeoutMs });

describe("remote indexed current-state inspection", () => {
  it("reads a real runner-owned WAL database through the native binary and duplex transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-native-inspection-"));
    const path = join(root, "runner-state.json"), database = join(root, "runner-state.sqlite");
    const db = new DatabaseSync(database);
    try {
      chmodSync(database, 0o600);
      writeFileSync(`${database}.lifetime`, "", { mode: 0o600 });
      writeFileSync(path, JSON.stringify({ schema: "paperclip.runner.durable.state.indexed.v1", binding: "inspection" }), { mode: 0o600 });
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE store_binding(singleton INTEGER PRIMARY KEY,schema_version INTEGER,binding TEXT); INSERT INTO store_binding VALUES(1,2,'inspection'); CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB); CREATE TABLE receipt_prepare(state_key TEXT,generation INTEGER,body BLOB,digest BLOB)");
      const state = { nextSourceSeq: 3, ackedSourceSeq: 1, activeInput: snapshot.state.activeInput };
      const bytes = Buffer.from(JSON.stringify(state)), stateDigest = createHash("sha256").update(bytes).digest();
      db.prepare("INSERT INTO current_state VALUES('runner',?,?,?)").run(9007199254740992n, bytes, stateDigest);
      const input = { runner: loopbackCheckpointDuplexRunner(), runnerBinary: resolvePaperclipRunnerBinary(), path };
      expect(await inspectRemoteIndexedState(input)).toEqual({ state: { ...state, outbox: [{ indexedPending: true }] }, generation: "9007199254740992", stateDigest: stateDigest.toString("hex"), preparation: null });
      db.exec("UPDATE current_state SET digest=zeroblob(32)");
      await expect(inspectRemoteIndexedState(input)).rejects.toThrow("invalid_or_incomplete");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("streams over ordinary RPC output capacity, preserves exact generation and pending work", async () => {
    const fixture = runner(frames());
    expect(await inspect(fixture)).toEqual(snapshot);
    expect(fixture.execute).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled(); expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.openDuplexChannel).toHaveBeenCalledWith({ command: ["/private/runnerd", "storage", "inspect-state", "--path", "/private/runner/runner-state.json"] });
  });
  it.each(["missing-footer", "digest", "reordered", "over-capacity", "short-chunk", "after-footer"])("rejects %s instead of treating missing output as settled state", async kind => {
    const rows = frames();
    if (kind === "missing-footer") rows.pop();
    if (kind === "digest") rows[0]!.sha256 = "b".repeat(64);
    if (kind === "reordered") rows[1]!.index = 1;
    if (kind === "over-capacity") rows[0]!.byteLength = 40 * 1024 * 1024 + 1;
    if (kind === "short-chunk") rows[1]!.bytes = "eA==";
    if (kind === "after-footer") rows.push({ complete: true });
    const fixture = runner(rows);
    await expect(inspect(fixture)).rejects.toThrow("invalid_or_incomplete");
    expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.close).toHaveBeenCalledOnce();
  });
  it.each([{ exitCode: 7, transportClosed: false }, { exitCode: 0, transportClosed: true }])("requires a clean command exit (%j)", async exit => {
    const fixture = runner(frames(), exit);
    await expect(inspect(fixture)).rejects.toThrow("invalid_or_incomplete"); expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("stops and closes its own channel on a stalled bounded current read", async () => {
    const fixture = runner([], undefined, true);
    await expect(inspect(fixture, 25)).rejects.toThrow("invalid_or_incomplete");
    expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.close).toHaveBeenCalledOnce();
  });
});
