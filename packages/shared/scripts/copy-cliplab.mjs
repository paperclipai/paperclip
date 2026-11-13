import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(root, "dist/cliplab");

mkdirSync(dest, { recursive: true });
copyFileSync(resolve(root, "src/cliplab/LICENSE"), resolve(dest, "LICENSE"));
copyFileSync(resolve(root, "src/cliplab/PROVENANCE.md"), resolve(dest, "PROVENANCE.md"));
