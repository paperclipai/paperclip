import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCursorNativeUsage } from "../scripts/cursor-native-usage.mjs";

const require = createRequire(import.meta.url);
const root = process.env.PAPERCLIP_TEST_ACPX_PACKAGE_ROOT ?? dirname(require.resolve("acpx/package.json"));
const { _: createConversation, y: recordSubmission, n: runPromptTurn,
  dt: serialize, ut: parse, tt: assertKeyPolicy, g: clone, E: apply } =
  await import(pathToFileURL(join(root, "dist/live-checkpoint-BSIrfgVo.js")));
const envelope = () => ({
  schema: "paperclip.cursor.native-usage.v1", source: "native_turn_ended",
  promptId: "12345678-1234-1234-1234-123456789abc", completeness: "partial",
  reasons: ["native_counter_semantics_unverified"],
  observations: [{ invocationId: "invocation-1", role: "parent", nativeRun: 1, sequence: 1,
    counters: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0 } }],
  limits: { maxObservations: 64, maxInvocations: 64, maxBytes: 16384 }, truncated: false,
});
const record = conversation => ({
  schema: "acpx.session.v1", acpxRecordId: "record-1", acpSessionId: "session-1", agentCommand: "verified-cursor",
  cwd: "/workspace", createdAt: "2026-09-30T00:00:00Z", lastUsedAt: "2026-09-30T00:00:00Z", lastSeq: 0,
  ...conversation,
});
async function prompt(conversation, metadata, options = {}) {
  const promptMessageId = options.promptMessageId ?? recordSubmission(conversation, "Fixture prompt");
  const result = await runPromptTurn({
    client: { prompt: async () => ({ stopReason: options.stopReason ?? "end_turn", usage: options.usage, _meta: { paperclipCursorUsage: metadata } }) },
    sessionId: "session-1", prompt: "Fixture prompt", conversation, promptMessageId,
    requestId: options.requestId ?? "request-1",
  });
  return { promptMessageId, result };
}

test("Cursor partial metadata persists separately through clone/apply/disk/reload without accounting", async () => {
  const conversation = createConversation(), metadata = envelope();
  const { promptMessageId } = await prompt(conversation, metadata);
  const expected = { request_id: "request-1", prompt_message_id: promptMessageId, receipt: metadata };
  assert.deepEqual(conversation.cursor_prompt_usage, expected);
  const cloned = clone(conversation);
  metadata.observations[0].counters.inputTokens = 999;
  assert.equal(cloned.cursor_prompt_usage.receipt.observations[0].counters.inputTokens, 12);
  const applied = record(createConversation()); apply(applied, cloned);
  const disk = serialize(applied); assertKeyPolicy(disk);
  const restored = parse(JSON.parse(JSON.stringify(disk)));
  assert.deepEqual(restored.cursor_prompt_usage, cloned.cursor_prompt_usage);
  assert.deepEqual(restored.request_token_usage, {});
  assert.deepEqual(restored.cumulative_token_usage, {});
  assert.equal(restored.cumulative_cost, undefined);
});

test("malformed, oversized, unknown, and unbound receipts cannot poison successful settlement", async () => {
  const malformed = [undefined, null, {}, { ...envelope(), extra: "DROP_ME" },
    { ...envelope(), reasons: ["DROP_ME"] }, { ...envelope(), promptId: "raw-native-id" },
    { ...envelope(), observations: [{ ...envelope().observations[0], counters: { inputTokens: -1 } }] },
    { ...envelope(), observations: Array(65).fill(envelope().observations[0]) },
    { ...envelope(), extra: "X".repeat(16384) }];
  for (const metadata of malformed) {
    const conversation = createConversation();
    assert.equal((await prompt(conversation, metadata)).result.stopReason, "end_turn");
    assert.equal(conversation.cursor_prompt_usage, undefined);
  }
  for (const options of [{ requestId: "invalid request" }, { promptMessageId: "missing-message" }, { stopReason: "refusal" }]) {
    const conversation = createConversation(); await prompt(conversation, envelope(), options);
    assert.equal(conversation.cursor_prompt_usage, undefined);
  }
});

test("duplicate request, prompt message, and native prompt receipts do not replace an accepted receipt", async () => {
  const conversation = createConversation(); const first = await prompt(conversation, envelope());
  const original = structuredClone(conversation.cursor_prompt_usage);
  const updated = { ...envelope(), promptId: "aaaaaaaa-1234-1234-1234-123456789abc" };
  await prompt(conversation, updated); // same request, new message
  assert.deepEqual(conversation.cursor_prompt_usage, original);
  await prompt(conversation, updated, { requestId: "request-2", promptMessageId: first.promptMessageId });
  assert.deepEqual(conversation.cursor_prompt_usage, original);
  await prompt(conversation, envelope(), { requestId: "request-2" });
  assert.deepEqual(conversation.cursor_prompt_usage, original);
  await prompt(conversation, updated, { requestId: "request-2", stopReason: "cancelled" });
  assert.equal(conversation.cursor_prompt_usage.request_id, "request-2");
  assert.equal(conversation.cursor_prompt_usage.receipt.promptId, updated.promptId);
});

test("reload discards missing/duplicate conversation-message bindings and tampered metadata only", async () => {
  const conversation = createConversation(); await prompt(conversation, envelope());
  for (const mutate of [
    disk => { disk.cursor_prompt_usage.prompt_message_id = "missing"; },
    disk => { disk.messages.push(structuredClone(disk.messages[0])); },
    disk => { disk.cursor_prompt_usage.receipt.observations[0].counters.secret = "DROP_ME"; },
  ]) {
    const disk = structuredClone(serialize(record(conversation))); mutate(disk);
    const restored = parse(disk);
    assert.ok(restored); assert.equal(restored.cursor_prompt_usage, undefined);
    assert.deepEqual(restored.request_token_usage, {});
  }
});


test("actual runtime manager threads request identity into persisted and reloaded Cursor diagnostics", { timeout: 10000 }, async () => {
  const { createAcpRuntime } = await import(pathToFileURL(join(root, "dist/runtime.js")));
  const cwd = await mkdtemp(join(tmpdir(), "acpx-cursor-usage-"));
  const records = new Map();
  const sessionStore = {
    async load(id) { const disk = records.get(id); return disk ? parse(structuredClone(disk)) : undefined; },
    async save(value) { const disk = serialize(value); assertKeyPolicy(disk); records.set(value.acpxRecordId, structuredClone(disk)); },
  };
  const wire = `
    const readline=require('node:readline');
    const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
      else if(m.method==='session/new'||m.method==='session/load') send({id:m.id,result:{sessionId:'session-1'}});
      else if(m.method==='session/prompt') send({id:m.id,result:{stopReason:'end_turn',_meta:{paperclipCursorUsage:${JSON.stringify(envelope())}}}});
    });
  `;
  const options = { cwd, sessionStore, agentRegistry: { resolve: () => "fixture", list: () => ["cursor"] }, permissionMode: "approve-all", timeoutMs: 3000,
    spawnAgent: () => spawn(process.execPath, ["-e", wire], { cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] }),
  };
  const runtime = createAcpRuntime(options); let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "cursor-usage", agent: "cursor", mode: "persistent", cwd });
    const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "exact-runtime-request" });
    const drained = (async () => { for await (const _event of turn.events) {} })();
    assert.equal((await turn.result).status, "completed"); await drained;
    const persisted = await sessionStore.load(handle.acpxRecordId);
    assert.equal(persisted.lastRequestId, "exact-runtime-request");
    assert.equal(persisted.cursor_prompt_usage.request_id, "exact-runtime-request");
    assert.equal(persisted.messages.filter(m => m?.User?.id === persisted.cursor_prompt_usage.prompt_message_id).length, 1);
    assert.deepEqual(persisted.request_token_usage, {}); assert.deepEqual(persisted.cumulative_token_usage, {});
    await runtime.close({ handle, reason: "fixture restart" });
    const reopenedRuntime = createAcpRuntime(options);
    const reopened = await reopenedRuntime.ensureSession({ sessionKey: "cursor-usage", agent: "cursor", mode: "persistent", cwd, resumeSessionId: handle.backendSessionId });
    try {
      const loaded = await sessionStore.load(reopened.acpxRecordId);
      assert.deepEqual(loaded.cursor_prompt_usage, persisted.cursor_prompt_usage);
    } finally { await reopenedRuntime.close({ handle: reopened, reason: "fixture complete" }); }
  } finally {
    if (handle) await runtime.close({ handle, reason: "fixture cleanup" });
    await rm(cwd, { recursive: true, force: true });
  }
});


test("actual native collector near-cap receipt persists with maximum legal request and message IDs", async () => {
  const collector = createCursorNativeUsage(envelope().promptId);
  for (let i = 0; i < 64; i++) collector.beginParent()?.observe({ message: { case: "turnEnded", value: Object.fromEntries(
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].map(k => [k, Number.MAX_SAFE_INTEGER])) } });
  const receipt = collector.finish();
  assert.equal(receipt.truncated, true); assert.ok(JSON.stringify(receipt).length > 15000);
  const conversation = createConversation(); recordSubmission(conversation, "fixture");
  const messageId = "m".repeat(240); conversation.messages[0].User.id = messageId;
  await prompt(conversation, receipt, { requestId: "r".repeat(240), promptMessageId: messageId });
  assert.deepEqual(conversation.cursor_prompt_usage.receipt, receipt);
  assert.ok(Buffer.byteLength(JSON.stringify(conversation.cursor_prompt_usage)) <= 16384);
  const restored = parse(serialize(record(conversation)));
  assert.deepEqual(restored.cursor_prompt_usage.receipt.observations, receipt.observations);
});


test("standard prompt token accounting stays independent of native diagnostic counters", async () => {
  const conversation = createConversation(); const native = envelope();
  native.observations[0].counters.inputTokens = 999999;
  const { promptMessageId } = await prompt(conversation, native, { usage: { inputTokens: 12, outputTokens: 3 } });
  assert.equal(conversation.request_token_usage[promptMessageId].input_tokens, 12);
  assert.equal(conversation.cumulative_token_usage.input_tokens, 12);
  assert.equal(conversation.cursor_prompt_usage.receipt.observations[0].counters.inputTokens, 999999);
  assert.equal(conversation.cumulative_cost, undefined);
});
