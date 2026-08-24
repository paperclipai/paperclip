import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildProtocolManifest } from "../scripts/generate-protocol-manifest.mjs";
import {
  assertCodexQuestionFixture,
  assertConformanceFixturePair,
  assertReplayFixtureCompatibility,
  loadSchemaCatalog,
  readJson,
} from "../scripts/protocol-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "protocol");

async function fixture(relativePath) {
  return (await readJson(resolve(protocolRoot, "fixtures", relativePath))).value;
}

test("all schema IDs are unique and all external references resolve", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  assert.equal(schemas.length, 18);
});

test("the generated manifest matches all checked-in schemas and fixtures", async () => {
  const expected = `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`;
  const actual = await readFile(resolve(protocolRoot, "manifest.json"), "utf8");
  assert.equal(actual, expected);
});

test("canonical replay fixtures use supported required versions", async () => {
  for (const name of [
    "duplicate-event.json",
    "failed-run.json",
    "happy-path.json",
    "interrupted-run.json",
    "source-gap.json",
  ]) {
    assert.equal(assertReplayFixtureCompatibility(await fixture(`replay/${name}`)).protocolVersion, 1);
  }
});

test("unknown additive fields remain compatible with PRP v1", async () => {
  const value = await fixture("replay/unknown-optional-fields.json");
  assert.equal(value.futureFixtureHint.producerVersion, "1.1-preview");
  assert.doesNotThrow(() => assertReplayFixtureCompatibility(value));
});

test("unknown required versions and schemas fail closed", async () => {
  const unsupported = await fixture("replay/unsupported-required-version.json");
  assert.throws(
    () => assertReplayFixtureCompatibility(unsupported),
    /unsupported_required_version: protocolVersion=2; supported=1/,
  );

  const eventVersion = structuredClone(await fixture("replay/happy-path.json"));
  eventVersion.events[0].schemaVersion = 2;
  assert.throws(() => assertReplayFixtureCompatibility(eventVersion), /unsupported_required_version/);

  const commandSchema = structuredClone(await fixture("replay/happy-path.json"));
  commandSchema.commands[0].schema = "paperclip.prp.command.v2";
  assert.throws(() => assertReplayFixtureCompatibility(commandSchema), /unsupported_required_schema/);
});

test("the Codex question fixture uses stable provider-neutral IDs", async () => {
  const value = await fixture("questions/codex.json");
  assert.doesNotThrow(() => assertCodexQuestionFixture(value));
  assert.deepEqual(Object.keys(value.canonicalResponse.answers), ["environment"]);
});

test("the cross-language conformance input and output have one stable identity", async () => {
  const input = await fixture("conformance-minimal-run.json");
  const output = await fixture("conformance-expected-output.json");
  assert.doesNotThrow(() => assertConformanceFixturePair(input, output));
  assert.equal(input.result.summary, output.result.summary);
});
