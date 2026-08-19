import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serializeCapabilityGeneratedSemanticContracts } from "../dist/semantic-tools/provider-neutral.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageRoot, "generated/capability/semantic-tool-contracts.json");
const generated = serializeCapabilityGeneratedSemanticContracts();

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    process.stderr.write("semantic-tool-contracts.json is stale; run generate:semantic-contracts\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated);
  process.stdout.write(`wrote ${outputPath}\n`);
}
