import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = process.env.PAPERCLIP_TEST_ACPX_PACKAGE_ROOT ?? dirname(require.resolve("acpx/package.json"));
const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import(pathToFileURL(join(root, "dist/runtime.js")));

// This record was written by the previous release: ACPX 0.13.1 with Paperclip's
// 0.13.1 patch, after one completed turn. Only absolute paths were replaced.
const savedRecord = JSON.parse(await readFile(new URL("./fixtures/acpx-0.13.1-session-record.json", import.meta.url), "utf8"));
const peer = String.raw`
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method) fs.appendFileSync(process.env.WIRE, JSON.stringify({ method: m.method, sessionId: m.params?.sessionId }) + '\n');
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'fresh-session' } });
  else if (m.method === 'session/load') send({ id: m.id, result: {} });
  else if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CARRIED_OK' } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  } else if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
});`;

test("a session saved by ACPX 0.13.1 continues under the installed ACPX", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "acpx-carry-forward-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const wire = join(dir, "wire.ndjson");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(stateDir, "sessions"), { recursive: true });
  await writeFile(join(stateDir, "sessions", "carried-key.json"), JSON.stringify({
    ...savedRecord,
    cwd,
    event_log: { ...savedRecord.event_log, active_path: join(stateDir, "sessions", "carried-key.stream.ndjson") },
  }));
  const children = [];
  const runtime = createAcpRuntime({
    cwd, sessionStore: createRuntimeStore({ stateDir }), permissionMode: "deny-all",
    agentRegistry: createAgentRegistry({ overrides: { fixture: "fixture-agent" } }),
    spawnAgent: () => {
      const child = spawn(process.execPath, ["-e", peer], { cwd, env: { WIRE: wire }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  });
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });

  const handle = await runtime.ensureSession({ sessionKey: "carried-key", agent: "fixture", mode: "persistent", cwd });
  assert.equal(handle.acpxRecordId, "carried-key");
  assert.equal(handle.backendSessionId, "carried-session");
  const turn = runtime.startTurn({ handle, text: "second turn", mode: "prompt", requestId: "turn-2", timeoutMs: 5_000 });
  let text = "";
  for await (const event of turn.events) if (event.type === "text_delta" && event.stream !== "thought") text += event.text;
  assert.equal((await turn.result).status, "completed");
  assert.equal(text, "CARRIED_OK");
  await runtime.close({ handle, reason: "carry-forward verified" });

  const methods = (await readFile(wire, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  // The provider conversation is loaded, never replaced by a new session.
  assert.ok(methods.some(entry => entry.method === "session/load" && entry.sessionId === "carried-session"));
  assert.equal(methods.some(entry => entry.method === "session/new"), false);
  assert.ok(methods.some(entry => entry.method === "session/prompt" && entry.sessionId === "carried-session"));
  const resaved = JSON.parse(await readFile(join(stateDir, "sessions", "carried-key.json"), "utf8"));
  // The earlier turn stays in the conversation, followed by the new one.
  assert.deepEqual(resaved.messages.flatMap(message => message.User ? [message.User.content[0].Text] : []), ["first turn", "second turn"]);
});
