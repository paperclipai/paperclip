import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const PINNED_ARM_CHUNK = "c01657c111f65153d7a40a923f01a5a86d393d1cd6893eaa03f71b9604d2af0c";
const hash = source => createHash("sha256").update(source).digest("hex");
function segment(source, start, end) {
  const first = source.indexOf(start); assert.ok(first >= 0, `Missing native method ${start}`);
  const last = source.indexOf(end, first + start.length); assert.ok(last > first, `Missing method boundary ${end}`);
  return source.slice(first, last);
}
const awaiter = (self, args, _promise, fn) => {
  const iterator = fn.apply(self, args ?? []);
  const next = value => { const result = iterator.next(value); return result.done ? Promise.resolve(result.value) : Promise.resolve(result.value).then(next); };
  return next();
};

/** Executes the pinned native mode methods with dependency doubles. No network,
 * model call, or claim that a selected mode exposes a particular tool. */
export async function qualifyCursorMode(source) {
  assert.equal(hash(source), PINNED_ARM_CHUNK, "Native source identity changed");
  const toAcp = mode => ({ default: "agent", plan: "plan", search: "ask" })[mode];
  const scope = { S: awaiter, T: { ACP_MODE_CONFIG_ID: "mode" }, p: { mb: toAcp }, _: { mb: toAcp }, i: { GI: { invalidParams: value => new Error(value.message) } }, w: { debugLog() {} } };
  const method = (start, end, name) => runInNewContext(`({${segment(source, start, end)}}).${name}`, scope);
  const setConfig = method("setSessionConfigOption(e)", "unstable_setSessionModel(e)", "setSessionConfigOption");
  const mapMode = method("mapAcpModeToCliMode(e)", "clientSupportsParameterizedModelPicker()", "mapAcpModeToCliMode");
  const modes = method("buildModesStateFromCliMode(e)", "buildModesState(e)", "buildModesStateFromCliMode");
  const configs = method("buildConfigOptions(e,t)", "buildModelsState(e)", "buildConfigOptions");
  const setMode = method("setMode(e){", "getCliMode(){", "setMode");
  const getCliMode = method("getCliMode(){", "sendCurrentModeUpdate(e)", "getCliMode");
  const rows = [];
  for (const selected of ["agent", "plan", "ask"]) {
    const metadata = new Map([["mode", "default"]]); const updates = [];
    const store = { getMetadata: key => metadata.get(key), setMetadata: (key, value) => metadata.set(key, value) };
    const makeSession = () => ({ agentStore: store, setMode, getCliMode, sendCurrentModeUpdate: async value => updates.push(value) });
    const session = makeSession();
    const host = { sessions: new Map([["native", { session }]]), sharedServices: {}, mapAcpModeToCliMode: mapMode, buildModesStateFromCliMode: modes, buildConfigOptions: configs, getModelPickerMode: () => "variants", getAcpAvailableModels: async () => [], buildVariantModelConfigOptions: async () => [] };
    const response = await setConfig.call(host, { sessionId: "native", configId: "mode", value: selected });
    assert.equal(response.configOptions[0].currentValue, selected);
    assert.equal(updates.at(-1), selected);
    // A reconstructed native session reads the same admitted metadata. Actual
    // database durability is deliberately outside this dependency-double proof.
    const loaded = makeSession();
    assert.equal((await configs.call(host, "native", loaded))[0].currentValue, selected);
    class Data { constructor(value) { Object.assign(this, value); } }
    const promptPart = segment(source, 'r=null!==(o=this.agentStore.getMetadata("mode"))', ',u=new a.h');
    const action = runInNewContext(`(function(){let o;const ${promptPart};return d;})`, { _: { cT: value => ({ nativeModeInput: value }) }, c: { UserMessageAction: Data, UserMessage: Data }, N: "offline fixture", n: {}, crypto: { randomUUID: () => "fixture" } }).call(loaded);
    assert.equal(action.userMessage.mode.nativeModeInput, metadata.get("mode"));
    rows.push({ selected, nativeMetadata: metadata.get("mode"), configAcknowledgement: selected, currentModeNotification: selected, reconstructedSessionAcknowledgement: selected, userMessageModeInput: action.userMessage.mode.nativeModeInput });
  }
  const planHandler = segment(source, '"./src/acp/interaction-handlers/create-plan-handler.ts"(e,t,n)', '},"./src/acp/resource-link-security.ts"');
  assert.doesNotMatch(planHandler, /setMode\(|setMetadata\("mode"/);
  return { schema: "paperclip.cursor.native-mode-offline-proof.v1", sourceSha256: hash(source), rows, planHandlerHasModeMutation: false, boundary: "pinned native config/session/UserMessage methods; storage, mode enum converter and transport doubled; no inference" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath) throw new Error("Usage: node qualify-cursor-mode.mjs PINNED_ARM_CHUNK OUTPUT_JSON");
  const proof = await qualifyCursorMode(await readFile(sourcePath, "utf8"));
  await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
}
