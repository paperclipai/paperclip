import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { KIMI_INSTRUCTION_RUNTIME_SOURCE } from "./kimi-instructions-runtime.mjs";

export const KIMI_RUNTIME_PATCH = Object.freeze({
  version: "paperclip-kimi-2.3.3-instructions-v6",
  vendorSha256: "f18b711e22947d473175126d0c2da437d641187963a3bc300d66e183060703e3",
  patchedSha256: "79980aa95c54f325a05cbdf883f74443705db28f3e412a1b5ae22929d939eb66",
});

const sha256 = value => createHash("sha256").update(value).digest("hex");

export function replaceKimiPatchAnchor(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Kimi runtime patch requires exactly one source anchor");
  return source.replace(before, () => after);
}

export function patchKimiRuntimeSource(input) {
  if (sha256(input) !== KIMI_RUNTIME_PATCH.vendorSha256) throw new Error("Kimi runtime patch input digest mismatch");
  let source = input;
  const replace = (before, after) => { source = replaceKimiPatchAnchor(source, before, after); };
  replace("#!/usr/bin/env node\n", `#!/usr/bin/env node
import { createHash as paperclipKimiCreateHash } from "node:crypto";
let paperclipKimiInstructionSnapshot;
function paperclipKimiInstructionState() {
  if (paperclipKimiInstructionSnapshot) return paperclipKimiInstructionSnapshot;
  const raw = process.env.PAPERCLIP_KIMI_INSTRUCTIONS;
  delete process.env.PAPERCLIP_KIMI_INSTRUCTIONS;
  return paperclipKimiInstructionSnapshot = (${KIMI_INSTRUCTION_RUNTIME_SOURCE})(raw, {
    createHash: paperclipKimiCreateHash, byteLength: value => Buffer.byteLength(value, "utf8")
  });
}
function paperclipKimiChildEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  delete environment.KIMI_API_KEY;
  delete environment.PAPERCLIP_KIMI_INSTRUCTIONS;
  return environment;
}
`);
  replace('function buildEnv(overrides) {\n\tif (overrides === void 0) return;\n\treturn {\n\t\t...process.env,\n\t\t...overrides\n\t};\n}',
    'function buildEnv(overrides) {\n\treturn paperclipKimiChildEnvironment(overrides);\n}');
  replace('env: globalThis.process.env', 'env: paperclipKimiChildEnvironment()');
  replace('\t\tbindTerminalCapability(terminal) {\n\t\t\tthis._terminalEnabled = terminal === true;\n\t\t}',
    '\t\tbindTerminalCapability(terminal) {\n\t\t\tthis._terminalEnabled = false;\n\t\t}');
  replace("\t\tget systemPrompt() {\n\t\t\treturn this.profileState.systemPrompt;\n\t\t}",
    "\t\tget systemPrompt() {\n\t\t\treturn paperclipKimiInstructionState().append(this.profileState.systemPrompt);\n\t\t}");
  replace("async function runAcpServerWithStream(stream, opts = {}) {\n",
    "async function runAcpServerWithStream(stream, opts = {}) {\n\tpaperclipKimiInstructionState();\n");
  replace('\t\tmerged() {\n\t\t\treturn {\n\t\t\t\t...Object.fromEntries(this.pluginServers),\n\t\t\t\t...Object.fromEntries(this.fileServers)\n\t\t\t};\n\t\t}',
    '\t\tmerged() {\n\t\t\treturn {};\n\t\t}');
  replace('\tawait pushFirstExisting$1(roots, USER_GENERIC_DIRS$1, osHomeDir, "user");', '');
  replace('async function projectRoots(workDir, options = {}) {\n', 'async function projectRoots(workDir, options = {}) {\n\treturn [];\n');
  replace('async function projectAgentRoots(fs, workDir, warn) {\n', 'async function projectAgentRoots(fs, workDir, warn) {\n\treturn [];\n');
  replace('async function userAgentRoots(fs, homeDir, osHomeDir, warn) {\n', 'async function userAgentRoots(fs, homeDir, osHomeDir, warn) {\n\treturn [];\n');
  replace('this.byEvent = indexHooks([...configured ?? [], ...pluginHooks]);', 'this.byEvent = new Map();');
  replace('\t\tasync evaluate(context) {\n\t\t\tfor (const policy of this.policies) {',
    '\t\tasync evaluate(context) {\n\t\t\treturn { policyName: "paperclip-runner", result: { kind: "ask" } };\n\t\t\tfor (const policy of this.policies) {');
  replace('if (req.display.kind !== "plan_review") return CANONICAL_OPTIONS;',
    'if (req.display.kind !== "plan_review") return CANONICAL_OPTIONS.filter(option => option.kind !== "allow_always");');
  replace('\t\t\t\ttoolName: name,\n\t\t\t\taction,\n\t\t\t\tdisplay\n\t\t\t};\n\t\t\tconst approvalContext = {',
    '\t\t\t\ttoolName: name,\n\t\t\t\ttoolInput: context.args,\n\t\t\t\taction,\n\t\t\t\tdisplay\n\t\t\t};\n\t\t\tconst approvalContext = {');
  replace('\t\ttitle: req.toolName,\n\t\tcontent\n', '\t\ttitle: req.toolName,\n\t\tkind: inferToolKind(req.toolName),\n\t\trawInput: req.toolInput,\n\t\tcontent\n');
  const bindRuntime = '\t\t\thandle.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId).accessor.get(IAgentRuntimeBindingService).switch(runtimeId);';
  replace(bindRuntime, `${bindRuntime}
\t\t\tconst paperclipProfile = handle.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId).accessor.get(IAgentProfileService);
\t\t\treturn paperclipKimiInstructionState().receipt(sessionId, paperclipProfile.getSystemPrompt());`);
  replace("\t\t\tawait this.bindSessionRuntime?.(sessionId);\n",
    "\t\t\tconst paperclipReceipt = await this.bindSessionRuntime?.(sessionId);\n\t\t\tif (!paperclipReceipt || paperclipReceipt.sessionId !== sessionId) throw new Error(\"Kimi native instruction receipt is missing\");\n\t\t\tthis.paperclipInstructionReceipts ??= new Map();\n\t\t\tthis.paperclipInstructionReceipts.set(sessionId, paperclipReceipt);\n");
  replace("\t\t\t\t...await this.activateSession(meta.id)\n",
    "\t\t\t\t...await this.activateSession(meta.id),\n\t\t\t\t_meta: { paperclipKimiInstructions: this.paperclipInstructionReceipts.get(meta.id) }\n");
  const lifecycleState = "\t\t\t\tconfigOptions: await acpSession.configOptions(),\n\t\t\t\tmodes: acpSession.modeState()\n\t\t\t};\n\t\t}\n\t\tasync ";
  replace(`${lifecycleState}resumeSession(params)`,
    `${lifecycleState.replace("modes: acpSession.modeState()", "modes: acpSession.modeState(),\n\t\t\t\t_meta: { paperclipKimiInstructions: this.paperclipInstructionReceipts.get(params.sessionId) }")}resumeSession(params)`);
  replace(`${lifecycleState}listSessions(params)`,
    `${lifecycleState.replace("modes: acpSession.modeState()", "modes: acpSession.modeState(),\n\t\t\t\t_meta: { paperclipKimiInstructions: this.paperclipInstructionReceipts.get(params.sessionId) }")}listSessions(params)`);
  replace('\t\t\t\tdriver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });',
    '\t\t\t\tif (event.reason === "failed") {\n\t\t\t\t\tdriver.reject(RequestError$1.internalError({ schema: "paperclip.kimi.provider-error.v1", kind: "provider_failed" }, "Kimi provider turn failed"));\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tdriver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });');
  const stepSchema = 'object({ type: string(), turnId: number$1().int().nonnegative(), step: number$1().int().positive(), stepId: string().min(1).max(256).optional(), finishReason: string().max(32).optional(), reason: string().max(32).optional() })';
  replace('\tagentEvents = {\n\t\t"turn.started": {', `\tagentEvents = {
\t\t"turn.step.started": { kind: "stream", name: "events", type: "turn.step.started", schema: ${stepSchema} },
\t\t"turn.step.completed": { kind: "stream", name: "events", type: "turn.step.completed", schema: ${stepSchema} },
\t\t"turn.step.interrupted": { kind: "stream", name: "events", type: "turn.step.interrupted", schema: ${stepSchema} },
\t\t"turn.started": {`);
  replace('\t\t\tthis.subscriptions.push(events.on("assistant.delta", (event) => {', `\t\t\tthis.subscriptions.push(
\t\t\t\tevents.on("turn.step.started", event => this.dispatchTurnEvent(event.turnId, () => this.paperclipKimiStep(event, "start"))),
\t\t\t\tevents.on("turn.step.completed", event => this.dispatchTurnEvent(event.turnId, () => this.paperclipKimiStep(event, "end"))),
\t\t\t\tevents.on("turn.step.interrupted", event => this.dispatchTurnEvent(event.turnId, () => this.paperclipKimiStep(event, "interrupted"))),
\t\t\t\tevents.on("assistant.delta", (event) => {`);
  replace('\t\tonAssistantDelta(event) {\n\t\t\tif (this.driverFor(event.turnId) === void 0) return;\n\t\t\tthis.emit(assistantDeltaToSessionUpdate(this.sessionId, event));\n\t\t}', `\t\tpaperclipKimiMessageFailure(driver) {
\t\t\tthis.settleDriver(driver, () => driver.reject(RequestError$1.internalError({ schema: "paperclip.kimi.provider-error.v1", kind: "message_boundary_invalid" }, "Kimi native message boundary is invalid")));
\t\t}
\t\tpaperclipKimiChunk(driver, text, kind, thought = false) {
\t\t\tthis.emit({ sessionId: this.sessionId, update: {
\t\t\t\tsessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
\t\t\t\tmessageId: driver.paperclipKimiMessage.id, content: { type: "text", text },
\t\t\t\t_meta: { origin: "kimi-native-assistant", source: "kimi-turn-step-v1", kind }
\t\t\t} });
\t\t}
\t\tpaperclipKimiStep(event, phase) {
\t\t\tconst driver = this.driverFor(event.turnId);
\t\t\tif (driver === void 0) return;
\t\t\tconst current = driver.paperclipKimiMessage;
\t\t\tif (!Number.isSafeInteger(event.step) || event.step < 1 || !Number.isSafeInteger(event.turnId) || event.turnId < 0) return this.paperclipKimiMessageFailure(driver);
\t\t\tif (phase === "start") {
\t\t\t\tif (current?.active || typeof event.stepId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(event.stepId) || current && event.step <= current.step) return this.paperclipKimiMessageFailure(driver);
\t\t\t\tdriver.paperclipKimiMessageIds ??= new Set();
\t\t\t\tconst id = "kimi-message-" + paperclipKimiCreateHash("sha256").update(JSON.stringify([this.sessionId, event.turnId, event.stepId])).digest("hex");
\t\t\t\tif (driver.paperclipKimiMessageIds.size >= 4096 || driver.paperclipKimiMessageIds.has(id)) return this.paperclipKimiMessageFailure(driver);
\t\t\t\tdriver.paperclipKimiMessageIds.add(id);
\t\t\t\tdriver.paperclipKimiMessage = { id, step: event.step, stepId: event.stepId, active: true };
\t\t\t\tthis.paperclipKimiChunk(driver, "", "start");
\t\t\t\treturn;
\t\t\t}
\t\t\tif (!current || current.step !== event.step || event.stepId !== void 0 && event.stepId !== current.stepId) return this.paperclipKimiMessageFailure(driver);
\t\t\tconst reason = phase === "interrupted" ? event.reason : event.finishReason;
\t\t\tconst reasons = phase === "interrupted" ? ["aborted", "max_steps", "error"] : ["end_turn", "max_tokens", "tool_use", "filtered", "paused", "other"];
\t\t\tif (!reasons.includes(reason)) return this.paperclipKimiMessageFailure(driver);
\t\t\tif (!current.active) {
\t\t\t\tif (phase === "interrupted") return;
\t\t\t\treturn this.paperclipKimiMessageFailure(driver);
\t\t\t}
\t\t\tthis.paperclipKimiChunk(driver, "", "end:" + reason);
\t\t\tcurrent.active = false;
\t\t}
\t\tonAssistantDelta(event) {
\t\t\tconst driver = this.driverFor(event.turnId);
\t\t\tif (driver === void 0) return;
\t\t\tif (!driver.paperclipKimiMessage?.active || typeof event.delta !== "string") return this.paperclipKimiMessageFailure(driver);
\t\t\tthis.paperclipKimiChunk(driver, event.delta, "delta");
\t\t}`);
  replace('\t\tonThinkingDelta(event) {\n\t\t\tif (this.driverFor(event.turnId) === void 0) return;\n\t\t\tthis.emit(thinkingDeltaToSessionUpdate(this.sessionId, event));\n\t\t}', `\t\tonThinkingDelta(event) {
\t\t\tconst driver = this.driverFor(event.turnId);
\t\t\tif (driver === void 0) return;
\t\t\tif (!driver.paperclipKimiMessage?.active || typeof event.delta !== "string") return this.paperclipKimiMessageFailure(driver);
\t\t\tthis.paperclipKimiChunk(driver, event.delta, "delta", true);
\t\t}`);
  return source;
}

export async function patchKimiRuntime(path) {
  const input = await readFile(path, "utf8");
  const digest = sha256(input);
  if (digest === KIMI_RUNTIME_PATCH.patchedSha256) return { ...KIMI_RUNTIME_PATCH };
  const patched = patchKimiRuntimeSource(input);
  if (sha256(patched) !== KIMI_RUNTIME_PATCH.patchedSha256) throw new Error("Kimi runtime patch output digest mismatch");
  await writeFile(path, patched);
  return { ...KIMI_RUNTIME_PATCH };
}

if (import.meta.url?.endsWith("/patch-kimi-runtime.mjs") && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("Usage: node patch-kimi-runtime.mjs <dist/main.mjs>");
  patchKimiRuntime(path).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Kimi runtime patch failed"}\n`);
    process.exitCode = 1;
  });
}
