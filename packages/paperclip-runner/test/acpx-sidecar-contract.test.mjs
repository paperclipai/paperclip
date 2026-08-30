import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

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
const protocolVersion = schema.$defs.request.properties.protocolVersion.const;

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

test("every ACPX sidecar message family declares the same version", () => {
  const versions = ["request", "response", "event"].map(
    (family) => schema.$defs[family].properties.protocolVersion.const,
  );
  assert.equal(new Set(versions).size, 1);
  assert.equal(Number.isInteger(versions[0]) && versions[0] > 0, true);
});

test("the ACPX sidecar schema id carries the declared protocol version", () => {
  assert.equal(
    schema.$id,
    `https://paperclip.dev/schemas/acpx-sidecar/v${protocolVersion}/message.schema.json`,
  );
});

function error() {
  return {
    code: "runtime_failed",
    message: "The runtime failed.",
    retryable: false,
  };
}
