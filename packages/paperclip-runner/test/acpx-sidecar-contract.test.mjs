import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { readAcpxSidecarProtocolVersion } from "../scripts/acpx-sidecar-contract.mjs";

const schema = JSON.parse(
  await readFile(
    new URL(
      "../protocol/provider-schemas/acpx-sidecar.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const protocolVersion = readAcpxSidecarProtocolVersion(schema);

const messages = [
  {
    protocolVersion,
    id: 1,
    command: "initialize",
    params: {},
  },
  {
    protocolVersion,
    id: 1,
    ok: true,
    result: {},
  },
  {
    protocolVersion,
    sequence: 1,
    eventType: "runtime.event",
    runId: "run-1",
    turnId: "turn-1",
    payload: {},
  },
];

test("the ACPX sidecar schema accepts each versioned message family", () => {
  for (const message of messages) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
  }
});

test("candidate startup and sidecar admission share one strict identity-bound JSON record", () => {
  const candidateAdmission = { schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-1", agent: "antigravity", model: "gemini-3.8-flash-low",
    profileDigest: `sha256:${"a".repeat(64)}`, nativeClosureDigest: `sha256:${"b".repeat(64)}`, platform: "darwin", architecture: "arm64",
    expiresAt: 1800000060000, runId: "run-1", normalizedSessionId: "session-1" };
  const startup = new Ajv2020({ allErrors: true, strict: true }).compile({ ...schema, oneOf: undefined, $ref: "#/$defs/candidateAdmission" });
  assert.equal(startup(candidateAdmission), true, JSON.stringify(startup.errors));
  for (const command of ["initialize", "session.open"]) {
    const request = { protocolVersion, id: 1, command, params: { agent: "antigravity", model: candidateAdmission.model, candidateAdmission } };
    assert.equal(validate(request), true, JSON.stringify(validate.errors));
    for (const change of [{ unknown: true }, { runId: undefined }, { normalizedSessionId: "wrong session" }, { platform: "linux" }, { expiresAt: "1800000060000" }]) {
      const altered = JSON.parse(JSON.stringify({ ...request, params: { ...request.params, candidateAdmission: { ...candidateAdmission, ...change } } }));
      assert.equal(validate(altered), false);
      assert.equal(startup(altered.params.candidateAdmission), false);
    }
    assert.equal(validate({ ...request, params: { ...request.params, agent: "codex" } }), false);
  }
  assert.equal(validate({ protocolVersion, id: 1, command: "turn.start", params: { candidateAdmission } }), false);
});

test("Pi session admission requires an explicit supported thinking level including recovery", () => {
  const open = (params) => ({ protocolVersion, id: 1, command: "session.open", params });
  for (const piThinkingLevel of ["off", "low", "high", "max"]) {
    assert.equal(validate(open({ agent: "pi", piThinkingLevel })), true, JSON.stringify(validate.errors));
    assert.equal(validate(open({ agent: "pi", piThinkingLevel, expectedIdentity: null })), true);
    assert.equal(validate(open({ agent: "pi", piThinkingLevel, expectedIdentity: { piThinkingLevel } })), true);
  }
  for (const piThinkingLevel of [undefined, null, "medium", "minimal", "xhigh", " LOW ", 1]) {
    assert.equal(validate(open({ agent: "pi", piThinkingLevel })), false);
    assert.equal(validate(open({ agent: "pi", piThinkingLevel: "low", expectedIdentity: { piThinkingLevel } })), false);
  }
  for (const agent of ["claude", "codex", "grok", "cursor", "copilot"]) {
    assert.equal(validate(open({ agent })), true);
    assert.equal(validate(open({ agent, expectedIdentity: null })), true);
    assert.equal(validate(open({ agent, piThinkingLevel: "low" })), false);
    assert.equal(validate(open({ agent, expectedIdentity: { piThinkingLevel: "low" } })), false);
  }
});

test("session.open accepts only the schema's closed parameter set", () => {
  const open = (params) => ({ protocolVersion, id: 1, command: "session.open", params });
  const names = Object.keys(schema.$defs.sessionOpenParams.properties);
  assert.ok(names.includes("grokEffort") && names.includes("runtimeContext"));
  for (const name of names.filter(name => !["agent", "piThinkingLevel", "claudeEffort", "candidateAdmission", "expectedIdentity", "providerPolicy"].includes(name))) {
    assert.equal(validate(open({ agent: "codex", [name]: "value" })), true, name);
  }
  assert.equal(validate(open({ agent: "codex", unsupportedField: true })), false);
  for (const providerPolicy of [null, { readOnly: true }, { readOnly: false }]) {
    assert.equal(validate(open({ agent: "codex", providerPolicy })), true, JSON.stringify(providerPolicy));
  }
  for (const providerPolicy of [{}, { readOnly: "yes" }, { readOnly: true, extra: true }]) {
    assert.equal(validate(open({ agent: "codex", providerPolicy })), false, JSON.stringify(providerPolicy));
  }
});

test("the runtime context schema closes every nested object", async () => {
  const runtimeSchema = JSON.parse(await readFile(new URL("../protocol/provider-schemas/runtime-context.schema.json", import.meta.url), "utf8"));
  const validateContext = new Ajv2020({ allErrors: true, strict: true }).compile(runtimeSchema);
  const hex = "a".repeat(64);
  const asset = { schema: "paperclip.runtime-asset.v1", digest: hex, manifestDigest: hex, rootPath: "/bundle", fileCount: 1, totalBytes: 2 };
  const context = {
    prompt: { revision: "paperclip-execution.v8", text: "prompt", digest: hex },
    instructions: { entryPath: "AGENTS.md", bundle: asset, workingCopy: { rootPath: "/work", entryPath: "AGENTS.md", kind: "agent_files" } },
    skills: [{ key: "skill", runtimeName: "skill", versionId: null, bundle: asset }],
    mcp: { assignmentSetId: "set", digest: hex, bindingId: null },
    connectionInstructions: { text: "connect", digest: hex },
    aggregateDigest: hex,
  };
  assert.equal(validateContext(context), true, JSON.stringify(validateContext.errors));
  const nested = [[], ["prompt"], ["instructions"], ["instructions", "bundle"], ["instructions", "workingCopy"], ["mcp"], ["connectionInstructions"]];
  for (const path of nested) {
    const altered = structuredClone(context);
    path.reduce((value, key) => value[key], altered).unexpected = true;
    assert.equal(validateContext(altered), false, path.join("."));
  }
  const alteredSkill = structuredClone(context);
  alteredSkill.skills[0].unexpected = true;
  assert.equal(validateContext(alteredSkill), false);
});

test("public Pi descriptors preserve effective thinking levels without invalidating historical replay", async () => {
  const descriptorSchema = JSON.parse(await readFile(new URL("../protocol/schemas/provider-descriptor.schema.json", import.meta.url), "utf8"));
  const validateDescriptor = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(descriptorSchema);
  const historical = {
    provider: "acpx", driver: "acpx_runtime", model: "model", executionKind: "local_process",
    providerVersion: "0.13.1", agent: "pi", requestedModel: "model", acpProtocolVersion: 1,
    agentServerPackage: "pi-acp", agentServerVersion: "0.0.33", acpxRecordId: null, agentProcessId: null,
  };
  assert.equal(validateDescriptor(historical), true, JSON.stringify(validateDescriptor.errors));
  for (const piThinkingLevel of ["off", "low", "high", "max"]) {
    assert.equal(validateDescriptor({ ...historical, piThinkingLevel }), true);
  }
  for (const piThinkingLevel of ["medium", null, "xhigh", 1]) {
    assert.equal(validateDescriptor({ ...historical, piThinkingLevel }), false);
  }
  assert.equal(validateDescriptor({ ...historical, agent: "copilot", piThinkingLevel: "low" }), false);
  assert.equal(validateDescriptor({ ...historical, provider: "codex", driver: "codex_app_server", piThinkingLevel: "low" }), false);
});

test("the ACPX sidecar schema shares the durable stable-identity boundary", () => {
  const longestTurnId = "t".repeat(240);
  assert.equal(validate({ ...messages[2], turnId: longestTurnId }), true);
  assert.equal(validate({ ...messages[2], turnId: "t".repeat(241) }), false);
  for (const turnId of ["turn 1", "réturn-1", "turn/1", "_turn-1"]) {
    assert.equal(validate({ ...messages[2], turnId }), false, turnId);
  }
  assert.equal(validate({ ...messages[2], runId: "r".repeat(161) }), false);
  for (const runId of ["run 1", "rún-1", "run/1", "_run-1"]) {
    assert.equal(validate({ ...messages[2], runId }), false, runId);
  }
});

test("rich activity has a closed display-only envelope and explicit run/turn scope", () => {
  const message = {
    ...messages[2],
    eventType: "runtime.rich_event",
    payload: { eventType: "plan.updated", itemId: "display-1", payload: {} },
  };
  assert.equal(validate(message), true, JSON.stringify(validate.errors));
  for (const field of ["runId", "turnId"]) {
    assert.equal(validate({ ...message, [field]: null }), false);
  }
  for (const eventType of ["turn.completed", "run.result.proposed", "semantic_tool.input", "unknown"]) {
    assert.equal(validate({ ...message, payload: { ...message.payload, eventType } }), false);
  }
  for (const field of ["sourceRef", "priority", "runId"]) {
    assert.equal(validate({ ...message, payload: { ...message.payload, [field]: "forged" } }), false);
  }
});

test("the ACPX sidecar schema fails closed on drift", () => {
  for (const message of [
    { ...messages[0], protocolVersion: protocolVersion + 1 },
    { ...messages[0], command: "session.destroy" },
    { protocolVersion, id: 1, ok: true, result: {}, error: error() },
    { protocolVersion, id: 1, ok: true },
    { protocolVersion, id: 1, ok: false },
    { protocolVersion, id: 1, ok: false, result: {}, error: error() },
    { ...messages[2], unexpected: true },
  ]) {
    assert.equal(validate(message), false);
  }
});

test("every ACPX sidecar message family uses the shared version", () => {
  for (const family of ["request", "response", "event"]) {
    assert.deepEqual(schema.$defs[family].properties.protocolVersion, {
      $ref: "#/$defs/protocolVersion",
    });
  }
});

test("the ACPX sidecar schema id carries the declared protocol version", () => {
  assert.equal(
    schema.$id,
    `https://paperclip.dev/schemas/acpx-sidecar/v${protocolVersion}/message.schema.json`,
  );
});

test("a coordinated family-version upgrade cannot outpace the schema id", () => {
  const driftedSchema = structuredClone(schema);
  driftedSchema.$defs.protocolVersion.const = protocolVersion + 1;

  assert.throws(
    () => readAcpxSidecarProtocolVersion(driftedSchema),
    /must match its authoritative schema \$id/,
  );
});

function error() {
  return {
    code: "runtime_failed",
    message: "The runtime failed.",
    retryable: false,
  };
}

test("turn control schema preserves explicit modes and rejects open-ended dispatch", () => {
  const message = { protocolVersion, id: 1, command: "turn.steer", params: {
    turnId: "turn-1", controlId: "control-1", mode: "follow_up", message: "Then validate",
  } };
  assert.equal(validate(message), true, JSON.stringify(validate.errors));
  for (const params of [ { ...message.params, mode: "cancel" }, { ...message.params, method: "arbitrary" },
    { ...message.params, controlId: "" }, { ...message.params, turnId: "wrong turn" }, { ...message.params, mode: undefined } ]) {
    assert.equal(validate({ ...message, params }), false);
  }
});

// Runtime payloads are provider-owned; the sidecar envelope stays closed.
// Pi validates native provenance before creating these boundary/history fields.
test("Pi native empty message boundaries and replay history fit the strict sidecar envelope", () => {
  for (const payload of [
    { type: "text_delta", stream: "output", text: "", messageId: "message-1", piMessageBoundary: { phase: "start" } },
    { type: "text_delta", stream: "output", text: "", messageId: "message-1", piMessageBoundary: { phase: "end", stopReason: "toolUse" } },
    { type: "text_delta", stream: "output", text: "Prior assistant reply", messageId: "history-1", piMessageHistory: true },
  ]) {
    assert.equal(validate({ ...messages[2], payload }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...messages[2], payload, piMessageBoundary: { phase: "start" } }), false);
  }
});
