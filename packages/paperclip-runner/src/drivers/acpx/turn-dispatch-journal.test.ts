import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE, GENERATED_ACPX_TURN_DISPATCH_SCHEMA } from "./generated-sidecar-contract.js";
import { createAcpxTurnDispatchJournal, isAcpPromptRequest } from "./turn-dispatch-journal.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "acpx-turn-dispatch-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

const lines = async (dir: string) => (await readFile(join(dir, GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE), "utf8"))
  .split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

describe("ACPX turn dispatch journal", () => {
  it("keeps one record set per turn: received truncates, dispatched appends", async () => {
    const dir = await directory();
    const first = createAcpxTurnDispatchJournal(dir, "turn-1");
    expect(first.markReceived()).toBe(true);
    first.markDispatched();
    expect(await lines(dir)).toEqual([
      { schema: GENERATED_ACPX_TURN_DISPATCH_SCHEMA, turnId: "turn-1", phase: "received" },
      { schema: GENERATED_ACPX_TURN_DISPATCH_SCHEMA, turnId: "turn-1", phase: "dispatched" },
    ]);
    createAcpxTurnDispatchJournal(dir, "turn-2").markReceived();
    expect(await lines(dir)).toEqual([{ schema: GENERATED_ACPX_TURN_DISPATCH_SCHEMA, turnId: "turn-2", phase: "received" }]);
  });

  it("never records a dispatch without its turn's received record, and never follows a symlink", async () => {
    const dir = await directory();
    expect(() => createAcpxTurnDispatchJournal(dir, "turn-1").markDispatched()).toThrow(/ENOENT/);
    const target = join(dir, "elsewhere");
    await writeFile(target, "");
    await symlink(target, join(dir, GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE));
    // The turn runs unjournaled, and the planted link is removed, not followed.
    expect(createAcpxTurnDispatchJournal(dir, "turn-1").markReceived()).toBe(false);
    expect(await readFile(target, "utf8")).toBe("");
    await expect(lstat(join(dir, GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no record when the start record cannot be written", async () => {
    const missing = join(await directory(), "missing");
    expect(createAcpxTurnDispatchJournal(missing, "turn-1").markReceived()).toBe(false);
  });

  it("recognizes only the prompt request", () => {
    expect(isAcpPromptRequest({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: {} })).toBe(true);
    expect(isAcpPromptRequest({ jsonrpc: "2.0", method: "session/prompt", params: {} })).toBe(false);
    expect(isAcpPromptRequest({ jsonrpc: "2.0", id: 3, method: "session/load", params: {} })).toBe(false);
    expect(isAcpPromptRequest({ jsonrpc: "2.0", id: 3, result: {} })).toBe(false);
  });

  // The proof depends on ACPX calling onAcpMessage("outbound") before it writes
  // the prompt to the provider. A real ACPX runtime and a controlled ACP peer
  // check that order: the peer refuses a prompt it receives before the journal
  // holds its dispatch record.
  it("is written before a real ACPX runtime sends the prompt to the provider", async () => {
    const dir = await directory();
    const journalPath = join(dir, GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE);
    const peer = String.raw`
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'journal-session' } });
  else if (m.method === 'session/prompt') {
    const journal = fs.existsSync(process.env.JOURNAL) ? fs.readFileSync(process.env.JOURNAL, 'utf8') : '';
    if (journal.includes('"phase":"dispatched"')) send({ id: m.id, result: { stopReason: 'end_turn' } });
    else send({ id: m.id, error: { code: -32603, message: 'prompt arrived before its dispatch record' } });
  }
});`;
    const children: ChildProcess[] = [];
    const journal = createAcpxTurnDispatchJournal(dir, "turn-ordered");
    let pending: typeof journal | null = null;
    const runtime = createAcpRuntime({
      cwd: dir,
      agentRegistry: createAgentRegistry({ overrides: { claude: "fixture" } }),
      sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }),
      permissionMode: "deny-all",
      onAcpMessage: (direction, value) => {
        if (direction === "outbound" && pending && isAcpPromptRequest(value)) {
          const current = pending;
          pending = null;
          current.markDispatched();
        }
      },
      spawnAgent: () => {
        const child = spawn(process.execPath, ["-e", peer], { cwd: dir, env: { ...process.env, JOURNAL: journalPath }, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        return child;
      },
    });
    try {
      const handle = await runtime.ensureSession({ sessionKey: "journal-ordering", agent: "claude", mode: "persistent", cwd: dir });
      journal.markReceived();
      pending = journal;
      const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "turn-ordered", timeoutMs: 5_000 });
      const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
      expect(await turn.result).toMatchObject({ status: "completed" });
      await drain;
      expect((await lines(dir)).map(line => line.phase)).toEqual(["received", "dispatched"]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await runtime.close?.({ handle: undefined as never, reason: "fixture done" }).catch(() => undefined);
    }
  }, 30_000);

  // A dispatch that cannot be journaled must never reach the provider, or a
  // lone `received` record would later prove a falsehood and duplicate it.
  it("keeps the prompt from a real ACPX provider when its dispatch record cannot be written", async () => {
    const dir = await directory();
    const seen = join(dir, "prompt-seen");
    const peer = String.raw`
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'journal-session' } });
  else if (m.method === 'session/prompt') { fs.appendFileSync(process.env.SEEN, 'prompt\n'); send({ id: m.id, result: { stopReason: 'end_turn' } }); }
});`;
    const children: ChildProcess[] = [];
    let armed = false;
    const runtime = createAcpRuntime({
      cwd: dir,
      agentRegistry: createAgentRegistry({ overrides: { claude: "fixture" } }),
      sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }),
      permissionMode: "deny-all",
      onAcpMessage: (direction, value) => {
        if (armed && direction === "outbound" && isAcpPromptRequest(value)) throw new Error("ENOSPC: dispatch record not written");
      },
      spawnAgent: () => {
        const child = spawn(process.execPath, ["-e", peer], { cwd: dir, env: { ...process.env, SEEN: seen }, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        return child;
      },
    });
    try {
      const handle = await runtime.ensureSession({ sessionKey: "journal-refused", agent: "claude", mode: "persistent", cwd: dir });
      armed = true;
      const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "turn-refused", timeoutMs: 5_000 });
      const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })().catch(() => undefined);
      const result = await turn.result.catch((error: unknown) => ({ status: "rejected", error }));
      await drain;
      expect(result.status).not.toBe("completed");
      // Give a stray write time to arrive before asserting it never did.
      await new Promise(resolve => setTimeout(resolve, 200));
      await expect(readFile(seen, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await runtime.close?.({ handle: undefined as never, reason: "fixture done" }).catch(() => undefined);
    }
  }, 30_000);
});
