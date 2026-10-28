import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildMcpInventory,
  buildSkillInventory,
  renderContractModule,
  validateInventorySchema,
  validateInventories,
} from "./lib/capability-inventory.mjs";

import { readInventory, inventoryOutputs, documentationOutputs } from "./lib/capability-inventory-storage.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const readSavedInventory = (name) => readInventory(resolve(packageRoot, `spec/capability/${name}.yaml`));
const inventories = {
  capabilities: await readSavedInventory("capabilities"),
  evaluations: await readSavedInventory("eval-traceability"),
  legacyMcpAliases: await readSavedInventory("mcp-tool-map"),
};
const inventorySchema = JSON.parse(await readFile(resolve(packageRoot, "spec/capability/inventory.schema.json"), "utf8"));
const errors = [
  ...validateInventorySchema(inventories, inventorySchema),
  ...validateInventories(inventories),
];
const repoRoot = resolve(packageRoot, "../..");
const [liveCapabilities, liveMcpTools] = await Promise.all([
  buildSkillInventory(repoRoot),
  buildMcpInventory(repoRoot),
]);
for (const [name, liveInventory] of [["capabilities", liveCapabilities], ["legacyMcpAliases", liveMcpTools]]) {
  const generatedIds = new Set(inventories[name].rows.map((row) => row.id));
  const liveIds = new Set(liveInventory.rows.map((row) => row.id));
  for (const id of liveIds) if (!generatedIds.has(id)) errors.push(`${name} is missing live source row ${id}.`);
  for (const id of generatedIds) if (!liveIds.has(id)) errors.push(`${name} has stale source row ${id}.`);
  const liveRows = new Map(liveInventory.rows.map((row) => [row.id, row]));
  for (const row of inventories[name].rows) {
    const liveRow = liveRows.get(row.id);
    if (!liveRow) continue;
    for (const field of ["sourceAnchor", "expectedSemantics", "foldedInto"]) {
      if (Object.hasOwn(liveRow, field) && JSON.stringify(row[field]) !== JSON.stringify(liveRow[field])) {
        errors.push(`${name}:${row.id} has stale ${field}.`);
      }
    }
  }
}
const expected = {
  [resolve(packageRoot, "src/generated/capability-contract.ts")]: renderContractModule(inventories),
  ...inventoryOutputs(packageRoot, inventories.capabilities),
  ...documentationOutputs(packageRoot, inventories),
};
for (const [path, source] of Object.entries(expected)) {
  if (await readFile(path, "utf8").catch(() => "") !== source) errors.push(`Generated output is stale: ${path}.`);
}
if (errors.length > 0) {
  process.stderr.write(`Capability inventory check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Capability inventory completeness and generated-output checks passed.\n");
}
