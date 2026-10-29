const { test } = await import(process.env.VITEST ? "vitest" : "node:test");
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const workflow = fs.readFileSync(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
const inline = name => workflow.match(new RegExp(`// BEGIN_AGENTMAIL_PRIVATE_${name}\\n([\\s\\S]+?)// END_AGENTMAIL_PRIVATE_${name}`))[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");
const tokenName = "PAPERCLIP_CHAT_EVAL_AGENTMAIL_API_TOKEN";
const selected = "chat-features.runner-opencode.local.chat-channels.outbound-email";
const otherSelected = "chat-features.runner-opencode.local.recovery.unknown-email-outcome";
const failure = "Selected AgentMail private input preparation failed; details withheld\n";
const cleanupFailure = "Selected AgentMail private input cleanup failed; details withheld\n";
function assertSelectedAllowlistAgreement(source) {
  const preparation = source.slice(source.indexOf("      - name: Prepare selected self-addressed"), source.indexOf("      - name: Run paid cell"));
  const paid = source.slice(source.indexOf("      - name: Run paid cell"), source.indexOf("      - name: Remove selected AgentMail"));
  const expressions = [
    preparation.match(/if: [^\n]*fromJSON\('([^']+)'\)/)?.[1],
    preparation.match(/const allowed = new Set\((\[[^\n]+\])\);/)?.[1],
    paid.match(/PAPERCLIP_CHAT_EVAL_AGENTMAIL_API_TOKEN: [^\n]*fromJSON\('([^']+)'\)/)?.[1],
  ];
  for (const expression of expressions) {
    assert.ok(expression, "Missing selected AgentMail allowlist boundary");
    assert.deepEqual(JSON.parse(expression), [selected, otherSelected], "AgentMail input and token delivery scopes must remain the same exact two cases");
  }
}
test("actual preparation, inline validation and paid token allowlists agree exactly", () => {
  assertSelectedAllowlistAgreement(workflow);
});
for (const boundary of ["preparation", "inline", "paid token"]) test(`policy control rejects ${boundary} allowlist drift`, () => {
  const start = workflow.indexOf(boundary === "paid token" ? "      - name: Run paid cell" : "      - name: Prepare selected self-addressed");
  const end = workflow.indexOf(boundary === "paid token" ? "      - name: Remove selected AgentMail" : "      - name: Run paid cell", start);
  const block = workflow.slice(start, end);
  const changed = boundary === "inline"
    ? block.replace(/(const allowed = new Set\()\[[^\n]+\](\);)/, `$1${JSON.stringify([selected, otherSelected, selected.replace("outbound-email", "reply-to-email")])}$2`)
    : block.replace(/fromJSON\('[^']+'\)/, `fromJSON('${JSON.stringify([selected, otherSelected, selected.replace("outbound-email", "reply-to-email")])}')`);
  assert.notEqual(changed, block);
  assert.throws(() => assertSelectedAllowlistAgreement(workflow.slice(0, start) + changed + workflow.slice(end)), /same exact two cases/);
});
function deliveryExpressions(source) {
  const preparation = source.slice(source.indexOf("      - name: Prepare selected self-addressed"), source.indexOf("      - name: Run paid cell"));
  const paid = source.slice(source.indexOf("      - name: Run paid cell"), source.indexOf("      - name: Remove selected AgentMail"));
  return [preparation.match(/if: ([^\n]+)/)?.[1], paid.match(/PAPERCLIP_CHAT_EVAL_AGENTMAIL_API_TOKEN: \$\{\{ (.+) \}\}/)?.[1]];
}
function evaluateDelivery(expression, change = {}) {
  assert.ok(expression, "Missing actual private delivery expression");
  const values = { id: selected, route: "private", verification: "success", cadence: "", ...change };
  return new Function("needs", "steps", "matrix", "secrets", "contains", "fromJSON", `return (${expression});`)(
    { catalog: { outputs: { operations_cadence: values.cadence } } },
    { manual_cell_route: { outputs: { route: values.route } }, manual_private_verified: { outcome: values.verification } },
    { executionId: values.id }, { [tokenName]: "synthetic-token" }, (items, id) => items.includes(id), JSON.parse,
  );
}
function assertPrivateDeliveryGates(source) {
  for (const expression of deliveryExpressions(source)) {
    for (const id of [selected, otherSelected]) assert.ok(evaluateDelivery(expression, { id }));
    for (const change of [
      { route: "actions" }, { route: "" }, { verification: "failure" }, { verification: "skipped" }, { verification: "" },
      { id: selected.replace("outbound-email", "reply-to-email") }, { id: selected.replace("runner-opencode", "runner-codex") },
      { id: selected.replace(".local.", ".daytona.") },
    ]) assert.ok(!evaluateDelivery(expression, change), "Input and token delivery require the exact private verified cell");
  }
  assert.ok(!evaluateDelivery(deliveryExpressions(source)[0], { cadence: "daily" }));
}
test("actual preparation and paid-token expressions reject unverified storage and unrelated cells", () => {
  assertPrivateDeliveryGates(workflow);
});
for (const boundary of ["preparation", "paid token"]) test(`actual ${boundary} control detects a removed storage-verification gate`, () => {
  const start = workflow.indexOf(boundary === "preparation" ? "      - name: Prepare selected self-addressed" : "      - name: Run paid cell");
  const end = workflow.indexOf(boundary === "preparation" ? "      - name: Run paid cell" : "      - name: Remove selected AgentMail", start);
  const block = workflow.slice(start, end), changed = block.replace("steps.manual_private_verified.outcome == 'success' && ", "");
  assert.notEqual(changed, block);
  assert.throws(() => assertPrivateDeliveryGates(workflow.slice(0, start) + changed + workflow.slice(end)), /exact private verified cell/);
});
function fixture(change = () => {}, fault = "") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentmail-workflow-control-")); fs.chmodSync(directory, 0o700);
  const githubEnv = path.join(directory, "github-env"); fs.writeFileSync(githubEnv, "", { mode: 0o600 });
  const config = { schemaVersion: 1, providers: { agentmail: { disposable: true, resourceIds: ["owned@example.test"], credentialEnv: [tokenName], prerequisites: { inboxId: "owned@example.test", recipient: "owned@example.test", recipientAuthorization: "self-addressed-only", apiTokenEnv: tokenName } } } };
  const key = Buffer.alloc(32, 41), token = "synthetic-owned-token-only";
  const env = { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_ENV: githubEnv, SELECTED_EXECUTION_ID: selected,
    [tokenName]: token, CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON: JSON.stringify(config), CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64: key.toString("base64") };
  try {
    change({ config, env, directory, githubEnv, token });
    const result = spawnSync(process.execPath, ["--input-type=module"], { input: fault + inline("INPUTS"), env, encoding: "utf8" });
    const exports = Object.fromEntries(fs.readFileSync(githubEnv, "utf8").trim().split("\n").filter(Boolean).map(row => row.split("=")));
    return { directory, githubEnv, config, key, token, env, result, exports, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
function noRawInputs(f, result = f.result) {
  const outputs = [result.stdout, result.stderr, fs.readFileSync(f.githubEnv, "utf8")];
  const raw = [f.token, f.env[tokenName], f.env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON, f.env.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64, "owned@example.test"];
  for (const value of raw.filter(Boolean)) for (const output of outputs) assert.ok(!output.includes(value), "Raw selected input reached an output boundary");
}
function clean(f, change = () => {}, fault = "") {
  const env = { PATH: process.env.PATH, RUNNER_TEMP: f.directory, PAPERCLIP_CHAT_QA_INPUT_ROOT: f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT,
    FAULT_PRIVATE_DIAGNOSTIC: f.token };
  change(env);
  return spawnSync(process.execPath, ["--input-type=module"], { input: fault + inline("CLEANUP"), env, encoding: "utf8" });
}
test("actual preparation stages both selected cells with private custody and the retained key", () => {
  for (const id of [selected, otherSelected]) {
    const f = fixture(({ env }) => { env.SELECTED_EXECUTION_ID = id; });
    try {
      assert.equal(f.result.status, 0); assert.equal(f.result.stdout, ""); assert.equal(f.result.stderr, ""); noRawInputs(f);
      assert.deepEqual(Object.keys(f.exports).sort(), ["PAPERCLIP_CHAT_QA_INPUT_ROOT", "PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG", "PAPERCLIP_CHAT_ORACLE_COMMITMENT_KEY"].sort());
      assert.equal(path.dirname(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT), fs.realpathSync(f.directory));
      assert.equal(fs.statSync(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT).mode & 0o777, 0o700);
      for (const name of ["PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG", "PAPERCLIP_CHAT_ORACLE_COMMITMENT_KEY"]) assert.equal(fs.statSync(f.exports[name]).mode & 0o777, 0o600);
      assert.deepEqual(fs.readFileSync(f.exports.PAPERCLIP_CHAT_ORACLE_COMMITMENT_KEY), f.key);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.exports.PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG)), f.config);
      assert.deepEqual(fs.readdirSync(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT).sort(), ["external-config.json", "oracle-hmac.key"]);
      const result = clean(f); assert.equal(result.status, 0); noRawInputs(f, result); assert.ok(!fs.existsSync(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT));
    } finally { f.cleanup(); }
  }
});
const invalid = [
  ["third email case", ({ env }) => { env.SELECTED_EXECUTION_ID = selected.replace("outbound-email", "reply-to-email"); }],
  ["different profile", ({ env }) => { env.SELECTED_EXECUTION_ID = selected.replace("runner-opencode", "runner-codex"); }],
  ["different environment", ({ env }) => { env.SELECTED_EXECUTION_ID = selected.replace(".local.", ".daytona."); }],
  ["missing token", ({ env }) => { delete env[tokenName]; }],
  ["short token", ({ env }) => { env[tokenName] = "short"; }],
  ["whitespace-only token", ({ env }) => { env[tokenName] = " ".repeat(20); }],
  ["leading token whitespace", ({ env, token }) => { env[tokenName] = " " + token; }],
  ["trailing token whitespace", ({ env, token }) => { env[tokenName] = token + " "; }],
  ["embedded token space", ({ env, token }) => { env[tokenName] = token + " middle"; }],
  ["token newline", ({ env, token }) => { env[tokenName] = token + "\n"; }],
  ["token carriage return", ({ env, token }) => { env[tokenName] = token + "\r"; }],
  ["token tab", ({ env, token }) => { env[tokenName] = token + "\t"; }],
  ["token control byte", ({ env, token }) => { env[tokenName] = token + "\x01"; }],
  ["token DEL byte", ({ env, token }) => { env[tokenName] = token + "\x7f"; }],
  ["token non-ASCII control", ({ env, token }) => { env[tokenName] = token + "\u0085"; }],
  ["missing configuration", ({ env }) => { delete env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON; }],
  ["JSON parser diagnostic containing input", ({ env, token }) => { env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON = `{"${token}":`; }],
  ["null configuration", ({ env }) => { env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON = "null"; }],
  ["oversize configuration", ({ env }) => { env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON = "x".repeat(65537); }],
  ["nonself recipient", ({ config }) => { config.providers.agentmail.prerequisites.recipient = "other@example.test"; }],
  ["missing authorization", ({ config }) => { delete config.providers.agentmail.prerequisites.recipientAuthorization; }],
  ["nondisposable provider", ({ config }) => { config.providers.agentmail.disposable = false; }],
  ["foreign resource", ({ config }) => { config.providers.agentmail.resourceIds = ["foreign@example.test"]; }],
  ["extra resource", ({ config }) => { config.providers.agentmail.resourceIds.push("foreign@example.test"); }],
  ["unrelated private inputs", ({ config }) => { config.providers.github = {}; }],
  ["extra credential reference", ({ config }) => { config.providers.agentmail.credentialEnv.push("PAPERCLIP_CHAT_EVAL_OTHER"); }],
  ["wrong token reference", ({ config }) => { config.providers.agentmail.prerequisites.apiTokenEnv = "GITHUB_TOKEN"; }],
  ["missing retained key", ({ env }) => { delete env.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64; }],
  ["wrong retained key length", ({ env }) => { env.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64 = Buffer.alloc(31).toString("base64"); }],
  ["noncanonical key encoding", ({ env }) => { env.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64 += "junk"; }],
  ["multiline temporary root", ({ env, directory }) => { const bad = path.join(directory, "bad\nroot"); fs.mkdirSync(bad); env.RUNNER_TEMP = bad; }],
];
for (const [name, change] of invalid) test(`actual preparation rejects ${name} without raw diagnostics or staging`, () => {
  const f = fixture(input => { change(input); if (!/configuration|diagnostic/.test(name)) input.env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON = JSON.stringify(input.config); });
  try {
    assert.equal(f.result.status, 1); assert.equal(f.result.stdout, ""); assert.equal(f.result.stderr, failure); noRawInputs(f);
    assert.equal(fs.readFileSync(f.githubEnv, "utf8"), ""); assert.ok(!fs.readdirSync(f.directory).some(name => name.startsWith("paperclip-agentmail-qa-")));
  } finally { f.cleanup(); }
});
const faults = [
  ["directory creation", `import injectedFs from "node:fs"; injectedFs.mkdtempSync = () => { throw new Error(process.env.${tokenName}); };\n`],
  ["directory permission", `import injectedFs from "node:fs"; injectedFs.chmodSync = () => { throw new Error(process.env.${tokenName}); };\n`],
  ["first file write", `import injectedFs from "node:fs"; injectedFs.writeFileSync = () => { throw new Error(process.env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON); };\n`],
  ["partial second file write", `import injectedFs from "node:fs"; const originalWrite = injectedFs.writeFileSync; injectedFs.writeFileSync = (p, v, o) => { if (p.endsWith("oracle-hmac.key")) { originalWrite(p, v.subarray(0, 3), o); throw new Error(process.env.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64); } return originalWrite(p, v, o); };\n`],
  ["environment export", `import injectedFs from "node:fs"; injectedFs.appendFileSync = () => { throw new Error(process.env.${tokenName}); };\n`],
  ["partial environment export", `import injectedFs from "node:fs"; const originalAppend = injectedFs.appendFileSync; injectedFs.appendFileSync = (p, v) => { originalAppend(p, v.slice(0, 13)); throw new Error(process.env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON); };\n`],
];
for (const [name, code] of faults) test(`actual preparation with ${name} failure withholds inputs and removes staged files`, () => {
  const f = fixture(() => {}, code);
  try {
    assert.equal(f.result.status, 1); assert.equal(f.result.stdout, ""); assert.equal(f.result.stderr, failure); noRawInputs(f);
    const staged = fs.readdirSync(f.directory).filter(name => name.startsWith("paperclip-agentmail-qa-"));
    assert.deepEqual(staged, []);
  } finally { f.cleanup(); }
});
test("actual cleanup removes private inputs after a failed paid command", () => {
  const f = fixture();
  try {
    const failed = spawnSync(process.execPath, ["-e", "process.exitCode=1"], { env: { PATH: process.env.PATH }, encoding: "utf8" }); assert.equal(failed.status, 1);
    const result = clean(f); assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); noRawInputs(f, result); assert.ok(!fs.existsSync(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT));
  } finally { f.cleanup(); }
});
for (const kind of ["unrelated directory", "symlink"]) test(`actual cleanup rejects ${kind} without raw diagnostics or removal`, () => {
  const f = fixture();
  try {
    const unrelated = path.join(f.directory, "unrelated"); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, "retain"), "synthetic");
    const root = kind === "symlink" ? path.join(f.directory, "paperclip-agentmail-qa-symlink") : unrelated;
    if (kind === "symlink") fs.symlinkSync(unrelated, root);
    const result = clean(f, env => { env.PAPERCLIP_CHAT_QA_INPUT_ROOT = root; });
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, cleanupFailure); noRawInputs(f, result); assert.equal(fs.readFileSync(path.join(unrelated, "retain"), "utf8"), "synthetic");
  } finally { f.cleanup(); }
});
for (const operation of ["realpathSync", "lstatSync", "rmSync"]) test(`actual cleanup ${operation} failure withholds diagnostics and remains failed`, () => {
  const f = fixture();
  try {
    const result = clean(f, () => {}, `import injectedFs from "node:fs"; injectedFs.${operation} = () => { throw new Error(process.env.FAULT_PRIVATE_DIAGNOSTIC); };\n`);
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, cleanupFailure); noRawInputs(f, result); assert.ok(fs.existsSync(f.exports.PAPERCLIP_CHAT_QA_INPUT_ROOT));
  } finally { f.cleanup(); }
});
test("preparation cleanup failure stays private and failed instead of claiming removal", () => {
  const fault = `import injectedFs from "node:fs"; const originalWrite = injectedFs.writeFileSync; injectedFs.writeFileSync = (p, v, o) => { if (p.endsWith("oracle-hmac.key")) throw new Error(process.env.${tokenName}); return originalWrite(p, v, o); }; injectedFs.rmSync = () => { throw new Error(process.env.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON); };\n`;
  const f = fixture(() => {}, fault);
  try {
    assert.equal(f.result.status, 1); assert.equal(f.result.stdout, ""); assert.equal(f.result.stderr, failure); noRawInputs(f); assert.equal(fs.readFileSync(f.githubEnv, "utf8"), "");
    const staged = fs.readdirSync(f.directory).filter(name => name.startsWith("paperclip-agentmail-qa-")); assert.equal(staged.length, 1);
    assert.equal(fs.statSync(path.join(f.directory, staged[0])).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.directory, staged[0], "external-config.json")).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});
test("workflow keeps private storage verification before inputs and cleanup before evidence", () => {
  assert.match(workflow, /environment:\n      name: runner-e2e-private-paid/);
  assertPrivateDeliveryGates(workflow);
  const names = ["Verify restricted complete evidence storage before model or fixture secrets", "Prepare selected self-addressed AgentMail inputs", "Run paid cell", "Remove selected AgentMail private input files", "Stage bounded campaign evidence", "Upload nonprivate packaged cell evidence", "Retain complete approved manual originals with no public fallback"];
  const positions = names.map(name => workflow.indexOf(`      - name: ${name}`));
  assert.ok(positions.every(position => position >= 0), "Every actual authorization/input/evidence step must exist");
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position));
  const prepare = workflow.slice(positions[1], positions[2]), paid = workflow.slice(positions[2], positions[3]);
  assert.ok(prepare.includes("CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON: ${{ secrets.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON }}"));
  assert.ok(prepare.includes("CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64: ${{ secrets.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64 }}"));
  assert.ok(!paid.includes("secrets.CHAT_CATALOG_AGENTMAIL_QA_CONFIG_JSON") && !paid.includes("secrets.CHAT_CATALOG_ORACLE_COMMITMENT_KEY_B64"));
  assert.match(workflow.slice(positions[3], positions[4]), /if: always\(\) && env.PAPERCLIP_CHAT_QA_INPUT_ROOT != ''/);
});
