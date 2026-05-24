import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(__dirname, "..", "ui", "src", "i18n", "locales");

const en = JSON.parse(readFileSync(resolve(localesDir, "en.json"), "utf8"));
const tr = JSON.parse(readFileSync(resolve(localesDir, "tr.json"), "utf8"));

const missingLeaves = [];
const missingTopLevel = [];

function diff(enNode, trNode, path) {
  if (typeof enNode !== "object" || enNode === null) {
    if (trNode === undefined) {
      missingLeaves.push({ path, value: enNode });
    }
    return;
  }
  for (const [key, value] of Object.entries(enNode)) {
    const childPath = path ? `${path}.${key}` : key;
    if (trNode === undefined || trNode === null || typeof trNode !== "object") {
      if (path === "") {
        missingTopLevel.push(key);
      }
      // entire subtree missing
      collectAllLeaves(value, childPath);
      continue;
    }
    if (!(key in trNode)) {
      if (path === "") {
        missingTopLevel.push(key);
      }
      collectAllLeaves(value, childPath);
      continue;
    }
    diff(value, trNode[key], childPath);
  }
}

function collectAllLeaves(node, path) {
  if (typeof node !== "object" || node === null) {
    missingLeaves.push({ path, value: node });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectAllLeaves(value, `${path}.${key}`);
  }
}

diff(en, tr, "");

console.log(`Missing leaves: ${missingLeaves.length}`);
console.log(`Missing top-level keys: ${missingTopLevel.length}`);
console.log("---TOP-LEVEL---");
console.log(missingTopLevel.join("\n"));
console.log("---LEAVES (path -> en value)---");
for (const { path, value } of missingLeaves) {
  console.log(`${path}\t${JSON.stringify(value)}`);
}
