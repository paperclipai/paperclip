import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

function segment(source, start, end) {
  const first = source.indexOf(start); assert.ok(first >= 0, `Missing ${start}`);
  const last = source.indexOf(end, first); assert.ok(last > first, `Missing ${end}`);
  return source.slice(first, last);
}
const sha = text => createHash("sha256").update(text).digest("hex");
class Data { constructor(value) { Object.assign(this, value); } }
const awaiter = (self, args, _promise, fn) => { const it = fn.apply(self, args ?? []); const go = value => { const n = it.next(value); return n.done ? Promise.resolve(n.value) : Promise.resolve(n.value).then(go); }; return go(); };

/** Executes digest-bound native methods with dependency doubles. No inference or
 * claim that the model obeyed the rules; this proves their RequestContext path. */
export async function qualifyCursorInstructions(source, platform, vendorRoot) {
  const text = "Paperclip governance\nCustom entry: résumé\nAGENT_HOME=/registered/agent";
  const payload = content => JSON.stringify({ schema: "paperclip.cursor.instructions.v1", content, digest: `sha256:${sha(content)}` });
  const helper = segment(source, "const paperclipCursorInstructionCrypto=", "var o=n(");
  const makeState = raw => runInNewContext(`${helper};paperclipCursorInstructionState`, {
    n: id => id === "node:crypto" ? crypto : { DX: Data, f5: Data, i9: Data }, process: { env: { PAPERCLIP_CURSOR_INSTRUCTIONS: raw } }, Buffer,
  });
  for (const invalid of [undefined, "{", payload("x\0y"), payload("x".repeat(32769)), payload(text).replace(sha(text), "0".repeat(64))]) assert.throws(() => makeState(invalid)(), /instruction binding/);
  assert.equal(makeState(payload(""))().rules.length, 0);
  const state = makeState(payload(text));
  assert.equal(state().rules[0].content, text);
  assert.equal(state().rules[0].type.type.case, "global");
  assert.equal(state(), state());
  assert.equal(state().ack.byteLength, Buffer.byteLength(text));
  const constructor = segment(source, "se=(e=oe)=>new d.DvK(", ",ie=se(oe)").slice(3);
  const resources = runInNewContext(`(${constructor})()`, { d: { DvK: Data }, n: {}, V: {}, J: {}, K: {}, q: "/workspace", U: "/workspace", H: undefined, ee: {}, Y: undefined, ne: {}, O: "session", oe: {}, paperclipCursorInstructionState: state });
  assert.equal(resources.additionalRules[0].content, text);
  const proof = { boundedPayloadRejected: true, explicitEmptyInstructions: true, nativeGlobalRule: true, nativeResourceAdditionalRules: true };
  if (platform !== "darwin-arm64") return proof;
  const main = await readFile(join(vendorRoot, platform, "dist-package/index.js"), "utf8");
  assert.equal(sha(main), "f8bd1c549f844859f8aeb9f06c01420f299bee22fe136695fe891eaf18674b12");
  const trace = { withName() { return this; } };
  const context = { Rm: (_stack, value) => value, S: { VI: ctx => ({ ctx, span: { setAttribute() {} } }) }, Jm: stack => { if (stack.hasError) throw stack.error; }, Qm: { warn() {} }, AbortSignal, performance, Pm: async () => ({}), Dm: () => ({}), vm: { bb: Data } };
  const global = runInNewContext(`({${segment(main, "async computeGlobalCache(e)", "dispose(){this.cacheDebounceTimeout")}}).computeGlobalCache`, context);
  const request = runInNewContext(`({${segment(main, "async computeCachedRequestContext(e,t)", "async execute(e,t)")}}).computeCachedRequestContext`, context);
  const captures = [];
  class Session { constructor(...args) { captures.push(args); } async replayConversationHistory() {} }
  const scope = { S: awaiter, crypto: { randomUUID }, process: { cwd: () => "/workspace" }, s: { resolve }, h: { z() {} }, C: { it: async () => ({}), Ag: class extends Error {}, rY: class extends Error {} }, y: { Y: async () => ({ resources, mcpLease: {} }), paperclipInstructionState: state }, f: { m: Session }, d: { debugLog() {} }, setTimeout() {} };
  const host = { isAuthenticated: true, sharedServices: { configProvider: { get: () => ({}) }, modelManager: { awaitCurrentModel: async () => ({}) }, teamSettingsService: {} }, ctx: {}, options: {}, deps: {}, connection: {}, clientCapabilities: {}, clientMetadata: {}, initializeSessionState: async () => ({ configOptions: [], models: {} }), buildModesState: () => ({}) };
  for (const [name, end] of [["newSession", "loadSession(e)"], ["loadSession", "unstable_listSessions(e)"]]) {
    const method = segment(source, `${name}(e)`, end);
    const response = await runInNewContext(`({${method}}).${name}`, scope).call(host, { cwd: "/workspace", sessionId: "fixture-session", mcpServers: [] });
    assert.equal(response._meta.paperclipCursorInstructions.digest, `sha256:${sha(text)}`);
    const globalCache = await global.call({ additionalRules: resources.additionalRules, cursorRulesService: { getAllCursorRules: async () => [{ content: "ambient project rules" }] }, repositoryProvider: { getCodebaseReference: async () => undefined } }, trace);
    const modelContext = await request.call({ globalCache: Promise.resolve(globalCache), mcpStateAccessor: { getState: async () => ({}) }, workspacePaths: [], collectWorkspaceCaches: async () => ({ gitRepos: [], gitRepoInfoComplete: true }) }, trace, {});
    assert.equal(modelContext.rules[0].content, text);
    assert.equal(modelContext.rules[1].content, "ambient project rules");
    proof[name] = { acknowledgementMatches: true, exactComposedBytesAtRequestContext: true, nativeRulePrecedencePreserved: true };
  }
  assert.equal(captures.length, 2);
  return { ...proof, mainSourceSha256: sha(main), boundary: "native RequestContext constructor; dependencies doubled; no inference" };
}
