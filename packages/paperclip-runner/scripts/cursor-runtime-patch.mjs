import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// This is an owned ACP-only patch of the immutable vendor archive. The legacy
// Cursor adapter and the vendor's interactive CLI are not changed.
export const CURSOR_RUNTIME_PATCH_VERSION = "paperclip-cursor-instructions-v2";
export const CURSOR_RUNTIME_PATCH_PINS = Object.freeze({
  "darwin-arm64": { file: "5672.index.js", before: "7784c8b16d4e639814c13b12be2a687f5dc2cd98cbf29ed0a10820778ab1bf62", after: "c01657c111f65153d7a40a923f01a5a86d393d1cd6893eaa03f71b9604d2af0c" },
  "darwin-x64": { file: "9841.index.js", before: "3c0aaf6ecc4fceb0f95e1731deec75384984570d14d0871cecec11972b948ac4", after: "cf0b5dbf4ec67219ce4fc49616af4c0041c4a9774e4b0840be170b749b8bc683" },
  "linux-x64": { file: "1699.index.js", before: "2de420f1b31e70ca74b083a1ce5b519c2abffa5789d71cc06e84d2c38acb7c07", after: "d3d634fc2080efac084f00e5d403a44d0edf1c39b02b02a4ed7d5ce0e8c703ff" },
});
const digest = value => createHash("sha256").update(value).digest("hex");

export function replaceCursorPatchAnchor(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Cursor runtime patch requires exactly one source anchor");
  return source.replace(before, () => after);
}

/** Never exported as a general-purpose runtime hook; bytes are checked first. */
export function patchCursorRuntimeSource(source, platform) {
  const pin = CURSOR_RUNTIME_PATCH_PINS[platform];
  if (!pin || digest(source) !== pin.before) throw new Error("Cursor runtime patch input digest mismatch");
  const replace = (before, after) => { source = replaceCursorPatchAnchor(source, before, after); };
  // Do not even initialize the ambient loader: load() can start subprocesses.
  replace(`te=r.aK.init(X,W.projectRoot,W.projectDir,!1,ee,new ${platform === "darwin-x64" ? "m" : "f"}.v)`, "te=null");
  replace("se=yield te.load(e),ie=new u.uz(se)", "se=new u.i9({}),ie=new u.uz(se)");
  // Session-scoped owned MCP stays functional, including an explicitly empty
  // list. It never borrows clients from an earlier session or ambient lease.
  const sessionMcp = platform === "darwin-arm64" ? "A" : "x";
  replace("if(0===i.length)return t.mcpLease;", `if(0===i.length)return new ${sessionMcp}.uz(new ${sessionMcp}.i9({}));`);
  replace("if(0===r.length)return t.mcpLease;", `if(0===r.length)return new ${sessionMcp}.uz(new ${sessionMcp}.i9({}));`);
  replace("u=Object.assign({},yield t.mcpLease.getClients(e))", "u=Object.create(null)");
  // Stop hook discovery at the source, including the asynchronous remote team
  // refresh. A filesystem watcher would leave an execution race here.
  replace("null!=re&&n.dashboardClient&&(ae=(0,y.a)({dashboardClient:n.dashboardClient,teamId:re}));", "void re;");
  replace("let ue=yield ce.load();", "let ue={errors:[],configDirs:{}};");
  // ACP ignores generic _meta.systemPrompt. Bind the controller-composed bytes
  // through the native global-rule request context, for both new and load. The
  // process-owned snapshot never discovers an instruction path in the workspace.
  const instructionModule = 'n.d(t,{Y:()=>K});';
  replace(instructionModule, `n.d(t,{Y:()=>K,paperclipInstructionState:()=>paperclipCursorInstructionState});
const paperclipCursorInstructionCrypto=n("node:crypto"),paperclipCursorInstructionRules=n("../proto/dist/generated/agent/v1/cursor_rules_pb.js");
let paperclipCursorInstructionSnapshot;
function paperclipCursorInstructionState(){
if(paperclipCursorInstructionSnapshot)return paperclipCursorInstructionSnapshot;
const raw=process.env.PAPERCLIP_CURSOR_INSTRUCTIONS;
if(typeof raw!=="string"||Buffer.byteLength(raw)>200000)throw new Error("Cursor instruction binding missing or oversized");
let value;try{value=JSON.parse(raw)}catch{throw new Error("Cursor instruction binding invalid")}
if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="content,digest,schema"||value.schema!=="paperclip.cursor.instructions.v1"||typeof value.content!=="string"||value.content.includes("\\0")||Buffer.byteLength(value.content)>32768||typeof value.digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(value.digest))throw new Error("Cursor instruction binding invalid");
const digest="sha256:"+paperclipCursorInstructionCrypto.createHash("sha256").update(value.content,"utf8").digest("hex");
if(value.digest!==digest)throw new Error("Cursor instruction binding digest mismatch");
const rules=value.content.length===0?[]:[new paperclipCursorInstructionRules.DX({fullPath:"paperclip://runtime/instructions",content:value.content,type:new paperclipCursorInstructionRules.f5({type:{case:"global",value:new paperclipCursorInstructionRules.i9}})})];
return paperclipCursorInstructionSnapshot=Object.freeze({rules,ack:Object.freeze({schema:"paperclip.cursor.instructions.v1",digest,byteLength:Buffer.byteLength(value.content)})});
}`);
  replace("cursorRulesService:n.cursorRulesService,", "cursorRulesService:n.cursorRulesService,additionalRules:paperclipCursorInstructionState().rules,");
  replace("S={sessionId:o,modes:this.buildModesState(a),models:I,configOptions:w}", "S={sessionId:o,modes:this.buildModesState(a),models:I,configOptions:w,_meta:{paperclipCursorInstructions:y.paperclipInstructionState().ack}}");
  const loadConfig = platform === "darwin-x64" ? "f" : "m";
  replace(`w={modes:this.buildModesState(r),models:b,configOptions:${loadConfig}}`, `w={modes:this.buildModesState(r),models:b,configOptions:${loadConfig},_meta:{paperclipCursorInstructions:y.paperclipInstructionState().ack}}`);
  // Use the exact SDK module already present in this verified vendor chunk.
  const sdk = [...source.matchAll(/n\("([^"\n]+@agentclientprotocol\/sdk\/dist\/acp\.js)"\)/g)].map(match => match[1]);
  if (new Set(sdk).size !== 1) throw new Error("Cursor runtime patch SDK identity is ambiguous");
  const errorType = "paperclipCursorResponseError";
  // processPrompt(e,t,n) shadows the webpack require name n. Bind the SDK
  // constructor at module scope rather than invoking that turn-ID argument.
  const sessionClass = platform === "darwin-arm64" ? "B" : "z";
  replace(`n.d(t,{m:()=>${sessionClass}});var s=n("node:fs/promises")`, `n.d(t,{m:()=>${sessionClass}});const ${errorType}=n(${JSON.stringify(sdk[0])}).GI;var s=n("node:fs/promises")`);
  const oldAction = 'if(e instanceof r.ao){const t=null!==(u={login:"Please sign in to continue",upgrade:"Upgrade your plan to continue",payment:"Add a payment method to continue",config:"Check your settings to continue"}[e.action])&&void 0!==u?u:e.message;return void(yield this.sendAgentMessageChunk(`\\n\\n${t}`))}';
  const newAction = `if(e instanceof r.ao){const action=["login","upgrade","payment","config"].includes(e.action)?e.action:"unknown";throw new (${errorType})(action==="login"?-32000:-32603,"Cursor provider action required: "+action,{schema:"paperclip.cursor.provider-error.v1",kind:"action_required",action})}`;
  replace(oldAction, newAction);
  replace('if(e instanceof g.T&&e.code===m.C.Unauthenticated)return void(yield this.sendAgentMessageChunk("\\n\\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs."));'.replace('m.C.Unauthenticated', `${platform === "darwin-x64" ? "f" : "m"}.C.Unauthenticated`),
    `if(e instanceof g.T&&e.code===${platform === "darwin-x64" ? "f" : "m"}.C.Unauthenticated)throw new (${errorType})(-32000,"Cursor provider authentication rejected",{schema:"paperclip.cursor.provider-error.v1",kind:"authentication_required"});`);
  return source;
}

export async function applyCursorRuntimePatch(directory, platform) {
  const pin = CURSOR_RUNTIME_PATCH_PINS[platform];
  if (!pin) throw new Error("Cursor runtime patch platform is unsupported");
  const path = join(directory, pin.file);
  const patched = patchCursorRuntimeSource(await readFile(path, "utf8"), platform);
  if (digest(patched) !== pin.after) throw new Error("Cursor runtime patch output digest mismatch");
  await writeFile(path, patched);
  return { patchVersion: CURSOR_RUNTIME_PATCH_VERSION, file: pin.file, sha256: pin.after };
}
