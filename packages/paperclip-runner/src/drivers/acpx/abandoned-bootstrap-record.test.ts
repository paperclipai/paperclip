import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { describe, expect, it } from "vitest";
import { resetAbandonedBootstrapRecord } from "./acpx-runtime-adapter.js";

// A controlled ACP peer that behaves like Claude: a session that never received
// a prompt was never saved, so session/load (and session/resume) of it fails.
const peer = String.raw`
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
let next = 0;
const prompted = new Set(JSON.parse(process.env.PROMPTED || '[]'));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: process.env.SESSION_PREFIX + (next++) } });
  else if (m.method === 'session/load') {
    if (prompted.has(m.params.sessionId)) send({ id: m.id, result: {} });
    else send({ id: m.id, error: { code: -32002, message: 'No conversation found with session ID: ' + m.params.sessionId } });
  }
  else if (m.method === 'session/prompt') send({ id: m.id, result: { stopReason: 'end_turn' } });
});`;

async function withRuntime<T>(dir: string, prefix: string, run: (input: {
  runtime: ReturnType<typeof createAcpRuntime>; methods: string[];
}) => Promise<T>): Promise<T> {
  const children: ChildProcess[] = [];
  const methods: string[] = [];
  const runtime = createAcpRuntime({
    cwd: dir,
    agentRegistry: createAgentRegistry({ overrides: { claude: "fixture" } }),
    sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }),
    permissionMode: "deny-all",
    onAcpMessage: (direction, value) => { if (direction === "outbound") methods.push((value as { method: string }).method); },
    spawnAgent: () => {
      const child = spawn(process.execPath, ["-e", peer], { cwd: dir, env: { ...process.env, SESSION_PREFIX: prefix }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  });
  try {
    return await run({ runtime, methods });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function prompt(runtime: ReturnType<typeof createAcpRuntime>, handle: Awaited<ReturnType<ReturnType<typeof createAcpRuntime>["ensureSession"]>>) {
  const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "first-turn", timeoutMs: 5_000 });
  const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
  const result = await turn.result;
  await drain;
  return result;
}

describe("a saved ACPX record from a bootstrap that stopped before any prompt", () => {
  async function abandonBootstrap(dir: string) {
    // The first bootstrap opens a session, then its runner stops before a turn.
    await withRuntime(dir, "abandoned-", async ({ runtime, methods }) => {
      const handle = await runtime.ensureSession({ sessionKey: "paperclip-session-key", agent: "claude", mode: "persistent", cwd: dir });
      expect(handle.backendSessionId).toBe("abandoned-0");
      expect(methods).toContain("session/new");
      await runtime.close({ handle, reason: "runner stopped before a turn" });
    });
  }

  it("is reused by a fresh open without a reset, so the first turn cannot load it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpx-abandoned-record-"));
    try {
      await abandonBootstrap(dir);
      await withRuntime(dir, "retry-", async ({ runtime, methods }) => {
        const handle = await runtime.ensureSession({ sessionKey: "paperclip-session-key", agent: "claude", mode: "persistent", cwd: dir });
        expect(handle.backendSessionId).toBe("abandoned-0");
        const result = await prompt(runtime, handle);
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result)).toMatch(/SESSION_RESUME_REQUIRED|could not be resumed|No conversation found/);
        expect(methods).toContain("session/load");
        expect(methods).not.toContain("session/prompt");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is replaced by a new provider session after the reset, and the first turn runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpx-abandoned-record-"));
    try {
      await abandonBootstrap(dir);
      expect(await resetAbandonedBootstrapRecord(createRuntimeStore({ stateDir: join(dir, "state") }), "paperclip-session-key")).toBe(true);
      await withRuntime(dir, "retry-", async ({ runtime, methods }) => {
        const handle = await runtime.ensureSession({ sessionKey: "paperclip-session-key", agent: "claude", mode: "persistent", cwd: dir });
        expect(handle.backendSessionId).toBe("retry-0");
        expect(await prompt(runtime, handle)).toMatchObject({ status: "completed" });
        expect(methods).toContain("session/new");
        expect(methods).not.toContain("session/load");
        expect(methods).toContain("session/prompt");
        await runtime.close({ handle, reason: "fixture cleanup" });
      });
      // The used session now holds a conversation, so a later reset leaves it alone.
      expect(await resetAbandonedBootstrapRecord(createRuntimeStore({ stateDir: join(dir, "state") }), "paperclip-session-key")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
