import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { CURSOR_RUNTIME_PATCH_PINS, patchCursorRuntimeSource } from "./cursor-runtime-patch.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const event = counters => ({ message: { case: "turnEnded", value: counters } });
function segment(source, start, end) {
  const first = source.indexOf(start); assert.ok(first >= 0, `Missing ${start}`);
  const last = source.indexOf(end, first + start.length); assert.ok(last > first, `Missing ${end}`);
  return source.slice(first, last);
}
function awaiter(self, args, _promise, fn) {
  const generator = fn.apply(self, args ?? []);
  const advance = (method, value) => {
    let step; try { step = generator[method](value); } catch (error) { return Promise.reject(error); }
    return step.done ? Promise.resolve(step.value) : Promise.resolve(step.value).then(
      value => advance("next", value), error => advance("throw", error));
  };
  return advance("next");
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** Actual pinned method/expression execution with transport and surrounding
 * session dependencies doubled. No provider entrypoint or inference is run. */
export async function qualifyCursorNativeUsage(vendorRoot) {
  const platforms = [];
  for (const [platform, pin] of Object.entries(CURSOR_RUNTIME_PATCH_PINS)) {
    const original = await readFile(join(vendorRoot, platform, "dist-package", pin.file), "utf8");
    assert.equal(hash(original), pin.before);
    const source = patchCursorRuntimeSource(original, platform);
    assert.equal(hash(source), pin.after);
    assert.throws(() => patchCursorRuntimeSource(original + "\n", platform), /digest mismatch/);
    const exported = {}; runInNewContext(source, { exports: exported });
    assert.ok(exported.modules["./src/acp/agent-session.ts"]);
    const collector = runInNewContext(segment(source, "const paperclipCreateCursorUsage=", ";const paperclipCursorResponseError=") + ";paperclipCreateCursorUsage");
    let ids = 0;
    const scope = { V: awaiter, G: 10, paperclipCreateCursorUsage: collector,
      crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}` } };
    const handlePrompt = runInNewContext(`({${segment(source, "handlePrompt(e){", "claimTaskToolCall(e,t){")}}).handlePrompt`, scope);
    const invocationSource = segment(source, "D=async e=>", ",yield D(y)");
    const childUpdate = runInNewContext(`({${segment(source, "onInteractionUpdate(e,t){", "onSessionCompleted(e,t){")}}).onInteractionUpdate`);
    // Execute the vendor's object construction and reuse transition, rather
    // than assuming a hand-built child's fields match the pinned implementation.
    const childLifecycle = runInNewContext(`(class {${segment(source, "beginOrUpdateRun(e,t){", "announce(e,t){")}}).prototype`);
    assert.ok(source.includes("yield this.processPrompt(e,s,l,paperclipUsage)"));
    assert.ok(source.includes("processPrompt(e,t,n,paperclipUsage){"));
    const checks = [];
    const createHost = backend => {
      const publisher = { turn: 0, children: new Map(), enabled: true,
        beginTurn() { return ++this.turn; }, runIdsForTurn() { return []; }, whenAllTerminal: async () => true,
        enqueue(_child, fn) { return fn(); }, turnFor() { return this.turn; },
        beginOrUpdateRun: childLifecycle.beginOrUpdateRun, resolveParentSession: childLifecycle.resolveParentSession,
        startNewRun: childLifecycle.startNewRun, onInteractionUpdate: childUpdate };
      const host = {
        subagentPublisher: publisher, subagentsEnabled: true, backgroundWorkRegistry: { abortWork() {} },
        ctx: { withCancel() { const abort = new AbortController(); return [{ signal: abort.signal, get canceled() { return abort.signal.aborted; } }, () => abort.abort()]; } },
        agentStore: { getConversationStateStructure: () => ({}), getBlobStore: () => ({}) }, resources: {},
        sharedServices: { agentClient: { run: backend } },
        async processPrompt(request, context, turn, usage) {
          const invoke = runInNewContext(`(function(){let D;${invocationSource};return D;})`, {
            paperclipUsage: usage, t: context, b: { modelDetails: {} }, $: { sendUpdate: async () => {} }, u: {}, x: [], A: [], M: {}, k: {},
          }).call(this);
          await request.execute({ invoke, usage, context, turn, publisher });
        },
      };
      return { host, publisher, run: request => handlePrompt.call(host, request) };
    };
    const successful = createHost(async (_context, _state, action, _model, callbacks) => {
      await callbacks.sendUpdate({}, event(action));
    });
    const first = await successful.run({ execute: async ({ invoke }) => { await invoke({ inputTokens: 12n }); await invoke({ outputTokens: 3n }); } });
    const envelope = first._meta.paperclipCursorUsage;
    assert.equal(first.stopReason, "end_turn"); assert.equal(first.usage, undefined);
    assert.equal(envelope.completeness, "partial");
    assert.deepEqual(plain(envelope.observations.map(row => row.counters)), [{ inputTokens: 12 }, { outputTokens: 3 }]);
    assert.equal(successful.publisher.paperclipUsageCollectors.size, 0);
    checks.push("exact_parent_invocation_capture", "separate_followups", "no_standard_usage");

    const second = await successful.run({ execute: async ({ invoke }) => { await invoke({ outputTokens: 1 }); } });
    assert.notEqual(second._meta.paperclipCursorUsage.promptId, envelope.promptId);
    assert.equal(second._meta.paperclipCursorUsage.observations.length, 1);
    checks.push("warm_prompt_isolation");

    const childHost = createHost(async () => {});
    const childResult = await childHost.run({ execute: async ({ publisher, turn }) => {
      const child = publisher.beginOrUpdateRun("native-child", { toolCallId: "native-tool", parentAgentId: "parent", name: "worker" });
      assert.equal(child.runs, 1); assert.equal(child.turn, turn); assert.equal(child.terminal, false);
      assert.equal(publisher.children.get("native-child"), child);
      child.presenter = { presentInteractionUpdate() {} };
      publisher.onInteractionUpdate("native-child", event({ inputTokens: 7n }));
      child.terminal = true;
      const reused = publisher.beginOrUpdateRun("native-child", { toolCallId: "native-tool-2", parentAgentId: "parent", name: "worker" });
      assert.equal(reused, child); assert.equal(reused.runs, 2); assert.equal(reused.terminal, false);
      assert.equal(reused.sessionId, "native-child.2"); assert.equal(reused.turn, turn);
      child.presenter = { presentInteractionUpdate() {} };
      publisher.onInteractionUpdate("native-child", event({ inputTokens: 8n }));
      publisher.onInteractionUpdate("unknown-history-child", event({ inputTokens: 999n }));
      child.terminal = true; publisher.onInteractionUpdate("native-child", event({ inputTokens: 999n }));
    } });
    const childEnvelope = childResult._meta.paperclipCursorUsage;
    assert.deepEqual(plain(childEnvelope.observations.map(row => [row.role, row.nativeRun, row.counters.inputTokens])), [["child", 1, 7]]);
    assert.ok(childEnvelope.reasons.includes("child_run_attribution_unverified"));
    childHost.publisher.children.get("native-child").terminal = false;
    childHost.publisher.onInteractionUpdate("native-child", event({ inputTokens: 999n }));
    assert.equal(childEnvelope.observations.length, 1);
    checks.push("vendor_child_creation_and_reuse", "child_run_attribution", "history_and_late_child_isolation");

    const started = deferred(), release = deferred(); let oldCallback;
    const overlapping = createHost(async (_context, _state, action, _model, callbacks) => {
      if (action === "first") { oldCallback = callbacks; started.resolve(); await release.promise; }
      await callbacks.sendUpdate({}, event({ inputTokens: action === "first" ? 10 : 20 }));
    });
    const pending = overlapping.run({ execute: async ({ invoke }) => invoke("first") });
    await started.promise;
    const next = await overlapping.run({ execute: async ({ invoke }) => invoke("second") });
    release.resolve(); const cancelled = await pending;
    assert.equal(cancelled.stopReason, "cancelled");
    assert.deepEqual(plain(cancelled._meta.paperclipCursorUsage.observations.map(row => row.counters.inputTokens)), [10]);
    assert.deepEqual(plain(next._meta.paperclipCursorUsage.observations.map(row => row.counters.inputTokens)), [20]);
    await oldCallback.sendUpdate({}, event({ inputTokens: 999 }));
    assert.equal(cancelled._meta.paperclipCursorUsage.observations.length, 1);
    assert.equal(overlapping.publisher.paperclipUsageCollectors.size, 0);
    checks.push("overlapping_cancellation", "late_parent_callback_isolation");

    const failure = createHost(async () => { throw new Error("fixture transport failure"); });
    await assert.rejects(failure.run({ execute: async ({ invoke }) => invoke({}) }), /fixture transport failure/);
    assert.equal(failure.publisher.paperclipUsageCollectors.size, 0);
    checks.push("exception_cleanup");
    platforms.push({ platform, vendorSha256: hash(original), candidateSha256: hash(source), checks });
  }
  return { schema: "paperclip.cursor.native-usage-offline-proof.v1", providerCalls: 0, standardUsageEmitted: false,
    boundary: "digest-pinned handlePrompt, native invocation, child creation/reuse and child update methods; surrounding session/transport doubled", platforms };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "Usage: node qualify-cursor-native-usage.mjs VENDOR_RESEARCH_ROOT");
  console.log(JSON.stringify(await qualifyCursorNativeUsage(process.argv[2]), null, 2));
}
