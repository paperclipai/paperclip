import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src/migrations");
const dest = resolve(root, "dist/migrations");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of readdirSync(src, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".sql")) {
    cpSync(resolve(src, entry.name), resolve(dest, entry.name));
  }
}
const sourceJournal = resolve(src, "meta", "_journal.json");
const destinationMeta = resolve(dest, "meta");
mkdirSync(destinationMeta, { recursive: true });
cpSync(sourceJournal, resolve(destinationMeta, "_journal.json"));
