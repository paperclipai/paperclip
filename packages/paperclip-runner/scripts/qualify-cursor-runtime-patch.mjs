import { qualifyCursorInstructions } from "./qualify-cursor-instructions.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CURSOR_RUNTIME_PATCH_PINS, CURSOR_RUNTIME_PATCH_VERSION, patchCursorRuntimeSource } from "./cursor-runtime-patch.mjs";

const runGenerator = (_self, _args, _promise, fn) => (async () => {
  const generator = fn(); let value;
  while (true) { const next = generator.next(value); if (next.done) return next.value; value = await next.value; }
})();
const trap = () => { throw new Error("Ambient configuration was accessed"); };
function segment(source, start, end) {
  const first = source.indexOf(start); assert.ok(first >= 0, `Missing ${start}`);
  const last = source.indexOf(end, first); assert.ok(last > first, `Missing ${end}`);
  return source.slice(first, last);
}

/** Executes relevant expressions from the actual digest-verified vendor chunk.
 * This is offline proof of the patch, not provider/tool availability evidence. */
export async function qualifyCursorRuntimePatch(vendorRoot) {
  const platforms = [];
  for (const [platform, pin] of Object.entries(CURSOR_RUNTIME_PATCH_PINS)) {
    const original = await readFile(join(vendorRoot, platform, "dist-package", pin.file), "utf8");
    const source = patchCursorRuntimeSource(original, platform);
    assert.equal(createHash("sha256").update(source).digest("hex"), pin.after);
    assert.throws(() => patchCursorRuntimeSource(original + "\n", platform), /digest mismatch/);
    assert.throws(() => patchCursorRuntimeSource(source, platform), /digest mismatch/);
    // Compiling the entire chunk catches minifier/scope syntax errors on every
    // platform without loading native code or executing provider entrypoints.
    const exported = {};
    runInNewContext(source, { exports: exported });
    assert.ok(exported.modules["./src/acp/shared-services.ts"]);
    const Lease = class { constructor(value) { this.value = value; } };
    // Both formerly ambient expressions are evaluated with poisoned loaders.
    const loader = segment(source, "te=null", ",ne=");
    assert.equal(runInNewContext(`let ${loader};te`, { r: { aK: { init: trap } } }), null);
    const empty = segment(source, "se=new u.i9({})", ",re=[]");
    assert.ok(runInNewContext(`let ${empty};ie`, { u: { i9: Lease, uz: Lease }, te: { load: trap } }) instanceof Lease);
    // Execute the complete pinned session MCP merge function. Any access to the
    // ambient lease fails, while owned injection and duplicate semantics survive.
    const mcpSource = segment(source, "ee=yield function(e,t,n,o)", "}(e,n,").slice("ee=yield ".length) + "}";
    const make = runInNewContext(`(${mcpSource})`, {
      j: runGenerator, R: runGenerator, A: { uz: Lease, i9: Lease, debugLog() {} },
      F: value => value.valid === false ? null : { serverName: value.name, config: value.config },
      x: { debugLog() {}, uz: Lease, i9: Lease }, N: name => `owned:${name}`,
      $: async ({ serverName, serverConfig }) => ({ serverName, serverConfig }),
    });
    const ambient = { get mcpLease() { return trap(); } };
    assert.deepEqual(Object.keys((await make({}, ambient, { mcpServers: [] }, "/workspace")).value.value), []);
    assert.deepEqual(Object.keys((await make({}, ambient, { mcpServers: [{ valid: false }] }, "/workspace")).value.value), []);
    const owned = (await make({}, ambient, { mcpServers: [{ name: "paperclip", config: "old" }, { name: "paperclip", config: "owned" }] }, "/workspace")).value.value;
    assert.equal(owned.paperclip.serverConfig, "owned");
    assert.deepEqual(Object.keys(owned), ["paperclip"]);
    // The remote team fetch and local config read are never evaluated, even
    // after a caller mutates their simulated config during this active session.
    const localHooks = segment(source, "let ue={errors:[],configDirs:{}};", "const he=");
    for (let mutation = 0; mutation < 2; mutation++) {
      const hooks = runInNewContext(`${localHooks}ue`, { ce: { load: trap } });
      assert.deepEqual(Object.keys(hooks), ["errors", "configDirs"]);
    }
    assert.ok(!source.includes("ae=(0,y.a)({dashboardClient:n.dashboardClient,teamId:re})"));
    // Exercise typed native errors; ordinary assistant prose is never inspected.
    const actionStart = "if(e instanceof r.ao)";
    const errors = segment(source, actionStart, "yield this.sendAgentMessageChunk(`\\n\\nError:");
    class ActionRequired extends Error { constructor(action) { super("private provider detail"); this.action = action; } }
    class ConnectError extends Error { constructor() { super("private auth detail"); this.code = 16; } }
    class ResponseError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }
    const binding = segment(source, "const paperclipCursorResponseError=", ";var s=");
    assert.equal(runInNewContext(`${binding};paperclipCursorResponseError`, { n: () => ({ GI: ResponseError }) }), ResponseError);
    const evaluate = error => runInNewContext(`(function(){${errors}})()`, { e: error, r: { ao: ActionRequired }, g: { T: ConnectError }, m: { C: { Unauthenticated: 16 } }, f: { C: { Unauthenticated: 16 } }, n: 123, paperclipCursorResponseError: ResponseError });
    for (const action of ["login", "upgrade", "payment", "config", "other"]) {
      assert.throws(() => evaluate(new ActionRequired(action)), error => error instanceof ResponseError
        && error.code === (action === "login" ? -32000 : -32603)
        && error.data.action === (action === "other" ? "unknown" : action)
        && !error.message.includes("private"));
    }
    assert.throws(() => evaluate(new ConnectError()), error => error.code === -32000 && error.data.kind === "authentication_required");
    evaluate(new Error("Upgrade your plan to continue"));
    platforms.push({ instructions: await qualifyCursorInstructions(source, platform, vendorRoot), platform, file: pin.file, sourceSha256: pin.before, patchedSha256: pin.after, driftRejected: true, fullChunkCompiles: true, ambientMcpAccesses: 0, ownedMcpPreserved: true, hookConfigReads: 0, remoteTeamHookFetches: 0, typedActionErrors: true, assistantProseIgnored: true });
  }
  return { schema: "paperclip.cursor.runtime-patch-proof.v1", patchVersion: CURSOR_RUNTIME_PATCH_VERSION, providerCalls: 0, qualification: "offline-only", platforms };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.equal(process.argv.length, 3, `Usage: node ${fileURLToPath(import.meta.url)} <vendor-archive-root>`);
  console.log(JSON.stringify(await qualifyCursorRuntimePatch(process.argv[2]), null, 2));
}
