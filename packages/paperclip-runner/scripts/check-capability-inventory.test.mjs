import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { capabilityGroups, validateInventorySchema, validateInventories } from "./lib/capability-inventory.mjs";

const inventorySchema = JSON.parse(await readFile(
  resolve(import.meta.dirname, "../spec/capability/inventory.schema.json"),
  "utf8",
));

function row(id, group = "hb") {
  return {
    id,
    group,
    sourceAnchor: "source:1",
    expectedSemantics: "semantic",
    primaryDisposition: "control_plane_owned",
    requiredGrants: [],
    assertionClasses: ["control_plane_invariant"],
    evidenceIds: [id],
  };
}

function validInventories() {
  const evaluations = Array.from({ length: 106 }, (_, index) => row(`eval-${index}`, capabilityGroups[index % capabilityGroups.length]));
  const aliases = Array.from({ length: 41 }, (_, index) => ({
    id: `mcp:tool-${index}`,
    name: `tool-${index}`,
    sourceAnchor: `source:${index + 1}`,
    expectedSemantics: `legacy semantic ${index}`,
    foldedInto: `eval:eval-${index}`,
    evidenceId: `mcp:tool-${index}`,
  }));
  for (const [index, alias] of aliases.entries()) {
    evaluations[index].legacyMcpAliases = [alias.id];
    evaluations[index].evidenceIds.push(alias.evidenceId);
  }
  return {
    capabilities: {
      schemaVersion: 2,
      inventoryRole: "normative",
      generatedFrom: ["skills/paperclip/SKILL.md"],
      rows: Array.from({ length: 152 }, (_, index) => row(`capability-${index}`)),
    },
    evaluations: {
      schemaVersion: 2,
      inventoryRole: "normative",
      generatedFrom: "paperclip-evals/cases",
      rows: evaluations,
    },
    legacyMcpAliases: {
      schemaVersion: 2,
      inventoryRole: "legacy_alias_index",
      generatedFrom: "packages/mcp-server/src/tools.ts",
      normativeSources: ["capabilities", "evaluations"],
      rows: aliases,
    },
  };
}

test("capability inventory validator accepts exact baseline counts", () => {
  const inventories = validInventories();
  assert.deepEqual(validateInventorySchema(inventories, inventorySchema), []);
  assert.deepEqual(validateInventories(inventories), []);
});

test("capability inventory validator rejects duplicate rows and invalid dispositions", () => {
  const inventories = validInventories();
  inventories.legacyMcpAliases.rows[1].id = inventories.legacyMcpAliases.rows[0].id;
  inventories.evaluations.rows[0].primaryDisposition = "both";
  const errors = validateInventories(inventories);
  assert.ok(errors.some((error) => error.includes("duplicate id")));
  assert.ok(errors.some((error) => error.includes("invalid primaryDisposition")));
});

test("capability inventory validator rejects an independent MCP classification", () => {
  const inventories = validInventories();
  inventories.legacyMcpAliases.rows[0].primaryDisposition = "optional_agent_tool";
  const schemaErrors = validateInventorySchema(inventories, inventorySchema);
  const errors = validateInventories(inventories);
  assert.ok(schemaErrors.some((error) => error.includes("boolean schema is false")));
  assert.ok(errors.some((error) => error.includes("must not define an independent primaryDisposition")));
});

test("capability inventory validator rejects missing, duplicate, and unknown MCP folds", () => {
  const inventories = validInventories();
  inventories.evaluations.rows[0].legacyMcpAliases = [];
  inventories.evaluations.rows[1].legacyMcpAliases.push(inventories.legacyMcpAliases.rows[1].id);
  inventories.legacyMcpAliases.rows[2].foldedInto = "eval:missing";
  const errors = validateInventories(inventories);
  assert.ok(errors.some((error) => error.includes("must be folded exactly once")));
  assert.ok(errors.some((error) => error.includes("unknown normative row")));
});
