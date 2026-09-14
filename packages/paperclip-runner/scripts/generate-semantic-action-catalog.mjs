import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPaperclipSemanticActionCatalog } from "../dist/catalog/semantic-action-catalog.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(
  packageRoot,
  "generated/semantic-action-catalog.json",
);
const generated = canonicalPaperclipSemanticActionCatalog();

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    process.stderr.write(
      "generated/semantic-action-catalog.json is stale; run generate:semantic-action-catalog\n",
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated);
  process.stdout.write(`wrote ${outputPath}\n`);
}
