import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCatalogManifest } from "../src/catalog-builder.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await writeCatalogManifest(packageDir);

if (result.errors.length > 0) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}

console.log(`Wrote ${result.manifest.teams.length} teams to generated/catalog.json`);
