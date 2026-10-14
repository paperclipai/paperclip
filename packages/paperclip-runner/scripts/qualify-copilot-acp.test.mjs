import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProbe, isExactMarkerWrite, permissionDecision } from "./qualify-copilot-acp.mjs";
const options = [{ kind: "allow_once", optionId: "native-approve-17" }, { kind: "allow_always", optionId: "native-session-3" }, { kind: "reject_once", optionId: "native-deny-0" }];
test("permission decisions preserve provider option identities and never select session-wide approval", () => {
  const params = { sessionId: "owned", options, toolCall: { rawInput: { command: "exact" } } };
  assert.deepEqual(permissionDecision("deny-write", params, "owned", "exact").outcome, { outcome: "selected", optionId: "native-deny-0" });
  assert.deepEqual(permissionDecision("detached-shell", params, "owned", "exact").outcome, { outcome: "selected", optionId: "native-approve-17" });
  for (const value of [{ ...params, sessionId: "other" }, { ...params, toolCall: { rawInput: { command: "changed" } } }]) assert.equal(permissionDecision("detached-shell", value, "owned", "exact").kind, "reject_once");
  assert.deepEqual(permissionDecision("deny-write", { ...params, options: [] }, "owned", "exact").outcome, { outcome: "cancelled" });
});
test("denial needs an actual rejected write and no side effect even after terminal", () => {
  const evidence = { scenario: "deny-write", stopReason: "end_turn", cleanupComplete: true, permissions: [{ exactSession: true, kind: "reject_once", writeAttempt: true, outcome: { outcome: "selected" } }], markerSamples: [{ exists: false }] };
  assert.equal(evaluateProbe(evidence).passed, true);
  assert.deepEqual(evaluateProbe({ ...evidence, permissions: [] }).failures, ["no_observed_denied_write_request"]);
  assert.deepEqual(evaluateProbe({ ...evidence, markerSamples: [{ exists: false }, { exists: true }] }).failures, ["denied_write_had_side_effect"]);
});
test("denial evidence requires the native write target, not an unrelated edit or command mention", () => {
  const marker = "/fixture/workspace/qualification-marker.txt";
  for (const fileName of [marker, "qualification-marker.txt", "./qualification-marker.txt"]) {
    assert.equal(isExactMarkerWrite({ kind: "edit", rawInput: { fileName } }, marker), true);
  }
  for (const toolCall of [
    { kind: "edit", rawInput: { fileName: "other.txt" } },
    { kind: "edit", rawInput: { fileName: "../qualification-marker.txt" } },
    { kind: "edit", rawInput: { fileName: `${marker}\0` } },
    { kind: "edit", rawInput: { command: "echo qualification-marker.txt" } },
    { kind: "execute", rawInput: { fileName: marker } },
    { kind: "edit" },
  ]) {
    const writeAttempt = isExactMarkerWrite(toolCall, marker);
    assert.equal(writeAttempt, false);
    assert.equal(evaluateProbe({ scenario: "deny-write", stopReason: "end_turn", cleanupComplete: true,
      permissions: [{ exactSession: true, kind: "reject_once", writeAttempt, outcome: { outcome: "selected" } }],
      markerSamples: [{ exists: false }],
    }).passed, false);
  }
});
test("retained real denial still passes the exact target oracle without another provider call", async () => {
  const { readFile } = await import("node:fs/promises");
  const evidence = JSON.parse(await readFile(new URL("../test/fixtures/copilot-live-denial-2026-09-28.json", import.meta.url), "utf8"));
  assert.equal(isExactMarkerWrite(evidence.nativeToolCall, "/fixture/workspace/qualification-marker.txt"), true);
});
test("detached settlement requires native mode, exact approval and output before terminal", () => {
  const evidence = { scenario: "detached-shell", stopReason: "end_turn", cleanupComplete: true, detachedToolObserved: true, backgroundCompletionObservedBeforeTerminal: true, permissions: [{ exactSession: true, kind: "allow_once", exactCommand: true }], markerAtTerminal: { matches: true } };
  assert.equal(evaluateProbe(evidence).passed, true);
  for (const field of ["detachedToolObserved", "backgroundCompletionObservedBeforeTerminal", "cleanupComplete"]) assert.equal(evaluateProbe({ ...evidence, [field]: false }).passed, false);
  assert.equal(evaluateProbe({ ...evidence, markerAtTerminal: { matches: false } }).passed, false);
  assert.equal(evaluateProbe({ ...evidence, failureCode: "request_deadline:session/prompt" }).passed, false);
});

test("missing credentials reject before resolving a pack or launching anything", async () => {
  const { runProbe } = await import("./qualify-copilot-acp.mjs");
  await assert.rejects(runProbe("/does-not-exist", "/unused", "deny-write", undefined), /explicit Copilot token required/);
});

test("full credential-free protocol fixture preserves numeric-zero denial and reaps its process", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runProbe } = await import("./qualify-copilot-acp.mjs");
  const root = await mkdtemp(join(tmpdir(), "copilot-risk-probe-test-"));
  const moduleRoot = join(root, "dist/drivers/acpx");
  try {
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "provider-pack.json"), JSON.stringify({ payload: { runnerSourceRevision: "fixture-only" }, digest: "fixture-only" }));
    await writeFile(join(moduleRoot, "qualified-profiles.js"), 'export const resolveQualifiedAcpxProfile = () => ({});');
    await writeFile(join(moduleRoot, "copilot-events.js"), 'export const COPILOT_ACP_CLIENT_CAPABILITIES = {};');
    const childScript = join(root, "child.mjs");
    await writeFile(childScript, `import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(!m.method){if(m.id!==0 || m.result?.outcome?.optionId!=='native-deny-0') process.exit(8); send({id:promptId,result:{stopReason:'end_turn'}});return;}
 let result={};
 if(m.method==='initialize')result={agentInfo:{version:'1.0.88'},agentCapabilities:{}};
 if(m.method==='session/new')result={sessionId:'fixture-session',models:{availableModels:[{modelId:'gpt-5.6-luna'}]}};
 if(m.method==='session/set_config_option')result={configOptions:[{id:'model',currentValue:'gpt-5.6-luna'}]};
 if(m.method==='session/prompt'){promptId=m.id;send({id:0,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{kind:'edit',rawInput:{fileName:process.cwd()+'/qualification-marker.txt'}},options:${JSON.stringify(options)}}});return;}
 send({id:m.id,result});
}).on('close',()=>process.exit(0));`);
    await writeFile(join(moduleRoot, "profile-installation.js"), `import { spawn } from 'node:child_process'; export const assertAcpxProfileEnvironment=()=>{}; export const verifyAcpxProfileInstallation=async()=>({commandDigest:'fixture-only',openCommand:async()=>({spawn:(_args,options)=>spawn(options.env.COPILOT_GITHUB_TOKEN === "fixture-spawn-failure" ? "/paperclip-fixture-missing-executable" : ${JSON.stringify(process.execPath)},[${JSON.stringify(childScript)}],options),close:async()=>{}})});`);
    const output = join(root, "output.json");
    const result = await runProbe(root, output, "deny-write", "fixture-token-never-used-for-network");
    const evidence = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.passed, true);
    assert.equal(evidence.permissions[0].requestId, 0);
    assert.deepEqual(evidence.permissions[0].outcome, { outcome: "selected", optionId: "native-deny-0" });
    assert.equal(evidence.cleanupComplete, true);
    assert.ok(evidence.markerSamples.every(sample => !sample.exists));
    assert.equal(evidence.providerReportedCostUsd, null);
    const failedOutput = join(root, "spawn-failure.json");
    const failed = await runProbe(root, failedOutput, "deny-write", "fixture-spawn-failure");
    const failedEvidence = JSON.parse(await readFile(failedOutput, "utf8"));
    assert.equal(failed.passed, false);
    assert.equal(failedEvidence.promptRequestsSent, 0);
    assert.equal(failedEvidence.cleanupComplete, true);
    assert.match(failedEvidence.failureCode, /provider_(spawn|stdin)_failure/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
