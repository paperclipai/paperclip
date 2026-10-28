#!/usr/bin/env node
// The persona character is the ClipLab studio export at
// ui/src/assets/cliplab/onboarding.character.json. The shared package cannot
// import JSON from ui, and its build is plain tsc, so this writes the export
// as a TypeScript module next to the engine. `--check` reports drift.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "ui/src/assets/cliplab/onboarding.character.json");
const target = path.join(root, "packages/shared/src/cliplab/character.ts");
const definition = JSON.parse(readFileSync(source, "utf8"));
const body = `// Generated from ui/src/assets/cliplab/onboarding.character.json by scripts/sync-cliplab-character.mjs. Do not edit.
import type { Definition } from "./model.js";

/** The persona character: Tonio's ClipLab studio export, every palette recolours its body. */
export const PAPERCLIP_CHARACTER: Definition = ${JSON.stringify(definition, null, 2)} as unknown as Definition;
`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { /* missing counts as drift */ }
  if (current !== body) { console.error(`packages/shared/src/cliplab/character.ts is out of date; run node scripts/sync-cliplab-character.mjs`); process.exit(1); }
  console.log("cliplab character in sync");
} else {
  writeFileSync(target, body);
  console.log(`wrote ${path.relative(root, target)}`);
}
