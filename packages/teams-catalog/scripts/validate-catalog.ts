import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../src/catalog-builder.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await validateCatalog(packageDir);

if (result.errors.length > 0) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${result.manifest.teams.length} teams.`);
