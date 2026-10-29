import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("acpx/package.json"));
const {
  _: createConversation, y: recordSubmission, n: runPromptTurn,
  dt: serialize, ut: parse, tt: assertKeyPolicy,
} = await import(pathToFileURL(join(root, "dist/live-checkpoint-BSIrfgVo.js")));

async function recordReceipt(metadata, usage = { inputTokens: 12, outputTokens: 3 }) {
  const conversation = createConversation();
  const promptMessageId = recordSubmission(conversation, "Fixture prompt");
  await runPromptTurn({
    client: { prompt: async () => ({ stopReason: "end_turn", usage: { ...usage, _meta: { paperclipPi: metadata, secret: "DROP_ME" } } }) },
    sessionId: "session-1", prompt: "Fixture prompt", conversation, promptMessageId,
  });
  return { conversation, promptMessageId };
}

test("Pi prompt receipts preserve exact per-request provenance and USD cost including zero", async () => {
  for (const provenance of ["assistant_message_receipts", "assistant_message_and_compaction_receipts"]) for (const costUsd of [0, 0.0025]) {
    const { conversation, promptMessageId } = await recordReceipt({ provenance, costUsd, extra: "DROP_ME" });
    assert.deepEqual(conversation.request_token_usage[promptMessageId].paperclip_pi, { provenance, cost_usd: costUsd });
    assert.equal(conversation.cumulative_token_usage.paperclip_pi, undefined);
    assert.equal(conversation.cumulative_cost, undefined);
    assert.equal(JSON.stringify(conversation).includes("DROP_ME"), false);
  }
});

test("missing cost stays missing and untrusted provenance or invalid costs never become receipts", async () => {
  const missing = await recordReceipt({ provenance: "assistant_message_receipts" }, {});
  assert.deepEqual(missing.conversation.request_token_usage[missing.promptMessageId].paperclip_pi, { provenance: "assistant_message_receipts" });
  for (const metadata of [{ provenance: "estimated", costUsd: 1 }, { provenance: "compaction_receipts", costUsd: 1 }, { provenance: "assistant_message_and_compaction_receipts", costUsd: -1 }, { provenance: "assistant_message_receipts", costUsd: -1 }, { provenance: "assistant_message_receipts", costUsd: Infinity }, { provenance: "assistant_message_receipts", costUsd: "0.01" }]) {
    const { conversation, promptMessageId } = await recordReceipt(metadata);
    assert.equal(conversation.request_token_usage[promptMessageId].paperclip_pi, undefined);
  }
});

test("terminal failures preserve billable Pi receipts for the failing request before reporting failure", async () => {
  for (const provenance of ["assistant_message_receipts", "assistant_message_and_compaction_receipts"]) {
    const { conversation, promptMessageId: previousId } = await recordReceipt({ provenance, costUsd: 0.001 });
    const promptMessageId = recordSubmission(conversation, "Fail after paid work");
    let failureReceipt;
    await assert.rejects(runPromptTurn({
      client: { prompt: async () => ({
        stopReason: "end_turn",
        usage: { inputTokens: 21, outputTokens: 8, _meta: { paperclipPi: { provenance, costUsd: 0.003 }, secret: "DROP_ME" } },
        _meta: { jetbrains: { air: { version: 1, sessionFailure: { severity: "error", category: "limit" } } } },
      }) },
      sessionId: "session-1", prompt: "Fail after paid work", conversation, promptMessageId,
      onTerminalSessionFailure() { failureReceipt = structuredClone(conversation.request_token_usage[promptMessageId]); },
    }), /ACP agent reported a terminal limit failure/);
    assert.equal(failureReceipt?.input_tokens, 21);
    assert.equal(failureReceipt?.output_tokens, 8);
    assert.deepEqual(failureReceipt?.paperclip_pi, { provenance, cost_usd: 0.003 });
    assert.equal(conversation.request_token_usage[previousId].paperclip_pi.cost_usd, 0.001);
    const disk = serialize({
      schema: "acpx.session.v1", acpxRecordId: "record-1", acpSessionId: "session-1", agentCommand: "verified-pi",
      cwd: "/workspace", createdAt: "2026-09-28T00:00:00Z", lastUsedAt: "2026-09-28T00:00:00Z", lastSeq: 0,
      ...conversation,
    });
    assertKeyPolicy(disk);
    const restored = parse(JSON.parse(JSON.stringify(disk)));
    assert.ok(restored);
    assert.deepEqual(restored.request_token_usage[promptMessageId].paperclip_pi, { provenance, cost_usd: 0.003 });
    assert.equal(restored.request_token_usage[promptMessageId].input_tokens, 21);
    assert.equal(restored.request_token_usage[promptMessageId].output_tokens, 8);
    assert.equal(JSON.stringify(restored).includes("DROP_ME"), false);
  }
});

for (const provenance of ["assistant_message_receipts", "assistant_message_and_compaction_receipts"]) test(`${provenance} survives canonical disk serialization/reload with a closed metadata shape`, async () => {
  const { conversation, promptMessageId } = await recordReceipt({ provenance, costUsd: 0.01 });
  const record = {
    schema: "acpx.session.v1", acpxRecordId: "record-1", acpSessionId: "session-1", agentCommand: "verified-pi",
    cwd: "/workspace", createdAt: "2026-09-28T00:00:00Z", lastUsedAt: "2026-09-28T00:00:00Z", lastSeq: 0,
    ...conversation,
  };
  const disk = serialize(record);
  assertKeyPolicy(disk);
  disk.request_token_usage[promptMessageId].paperclip_pi.extra = "DROP_ME";
  const restored = parse(JSON.parse(JSON.stringify(disk)));
  assert.ok(restored);
  assert.deepEqual(restored.request_token_usage[promptMessageId].paperclip_pi, { provenance, cost_usd: 0.01 });
  assert.equal(JSON.stringify(restored).includes("DROP_ME"), false);
});
