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
