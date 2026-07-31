import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCatalog } from "../src/catalog-builder.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await validateCatalog(packageDir);

if (result.errors.length > 0) {
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Catalog manifest is valid with ${result.manifest.skills.length} catalog skills.`);
}
