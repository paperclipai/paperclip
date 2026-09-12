import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serializeCapabilityGeneratedSemanticContracts } from "../dist/semantic-tools/provider-neutral.js";
import { PAPERCLIP_RUNNER_BUILD_METADATA } from "../dist/evals/build-metadata.js";
import { buildProtocolManifest } from "./generate-protocol-manifest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageRoot, "generated/capability/semantic-tool-contracts.json");
const generated = serializeCapabilityGeneratedSemanticContracts();
const manifestPath = resolve(packageRoot, "protocol/manifest.json");
// This is an explicitly seeded schema fixture, not retained live evidence.
// Keep its advertised catalog identity synchronized with the shipped contracts.
const fixturePath = resolve(packageRoot, "protocol/fixtures/evals/native-execution-seeded.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const fixtureCurrent = fixture.runner.catalogSha256 === PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog.sha256;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    process.stderr.write("semantic-tool-contracts.json is stale; run generate:semantic-contracts\n");
    process.exitCode = 1;
  }
  if (!fixtureCurrent) {
    process.stderr.write("native-execution-seeded.json catalog is stale; run generate:semantic-contracts\n");
    process.exitCode = 1;
  }
  const manifest = `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`;
  if (await readFile(manifestPath, "utf8").catch(() => "") !== manifest) {
    process.stderr.write("protocol/manifest.json is stale; run generate:semantic-contracts\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated);
  if (!fixtureCurrent) {
    fixture.runner.catalogSha256 = PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog.sha256;
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  // The manifest hashes fixture bytes, so refresh it after the seeded catalog.
  await writeFile(manifestPath, `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`);
  process.stdout.write(`wrote ${outputPath} and ${manifestPath}\n`);
}
