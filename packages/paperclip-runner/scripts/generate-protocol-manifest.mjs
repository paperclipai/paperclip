import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_FIXTURE_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  assertCodexQuestionFixture,
  assertConformanceFixturePair,
  assertReplayFixtureCompatibility,
  assertSchemaInstance,
  compileProtocolValidators,
  listJsonFiles,
  loadSchemaCatalog,
  portableRelative,
  readJson,
  sha256,
} from "./protocol-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "protocol");
const schemaDirectory = resolve(protocolRoot, "schemas");
const fixtureDirectory = resolve(protocolRoot, "fixtures");
const outputPath = resolve(protocolRoot, "manifest.json");
const expectedRejectedFixture = "fixtures/replay/unsupported-required-version.json";

export async function buildProtocolManifest() {
  const schemas = await loadSchemaCatalog(schemaDirectory);
  const validators = compileProtocolValidators(schemas);
  const fixtureFiles = await listJsonFiles(fixtureDirectory);
  const fixtures = [];
  const fixtureValues = new Map();

  for (const path of fixtureFiles) {
    const relativePath = portableRelative(protocolRoot, path);
    const { source, value } = await readJson(path);
    fixtureValues.set(relativePath, value);
    let expectation = "accept";
    let compatibilityCase = "canonical";

    if (relativePath.startsWith("fixtures/replay/")) {
      if (relativePath === expectedRejectedFixture) {
        expectation = "reject";
        compatibilityCase = "unknown-required-version";
        try {
          assertReplayFixtureCompatibility(value);
          throw new Error(`${relativePath} did not fail closed`);
        } catch (error) {
          if (!String(error.message).startsWith("unsupported_required_version:")) throw error;
        }
        assertSchemaInstance(validators.fixture, value, relativePath, false);
      } else {
        assertReplayFixtureCompatibility(value);
        assertSchemaInstance(validators.fixture, value, relativePath);
        if (relativePath.endsWith("unknown-optional-fields.json")) {
          compatibilityCase = "additive-optional-fields";
        }
      }
    } else if (relativePath === "fixtures/questions/codex.json") {
      assertCodexQuestionFixture(value);
      assertSchemaInstance(validators.questionAdapterFixture, value, relativePath);
      compatibilityCase = "codex-structured-input";
    } else if (relativePath === "fixtures/conformance-minimal-run.json") {
      assertSchemaInstance(validators.conformanceFixture, value, relativePath);
      compatibilityCase = "cross-language-input";
    } else if (relativePath === "fixtures/conformance-expected-output.json") {
      assertSchemaInstance(validators.conformanceOutput, value, relativePath);
      compatibilityCase = "cross-language-output";
    }

    fixtures.push({
      path: relativePath,
      sha256: sha256(source),
      expectation,
      compatibilityCase,
    });
  }

  assertConformanceFixturePair(
    fixtureValues.get("fixtures/conformance-minimal-run.json"),
    fixtureValues.get("fixtures/conformance-expected-output.json"),
  );

  return {
    schema: "paperclip.prp.contract_manifest.v1",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    fixtureVersion: SUPPORTED_FIXTURE_VERSION,
    generatedFrom: ["protocol/schemas", "protocol/fixtures"],
    schemas: schemas.map((record) => ({
      path: portableRelative(protocolRoot, record.path),
      id: record.value.$id,
      sha256: sha256(record.source),
    })),
    fixtures,
  };
}

async function main() {
  const encoded = `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== encoded) {
      process.stderr.write("The generated PRP contract manifest is stale. Run pnpm generate:protocol-manifest.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("The generated PRP contract manifest matches its sources.\n");
    }
  } else {
    await writeFile(outputPath, encoded);
    process.stdout.write(`Wrote ${outputPath}\n`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
