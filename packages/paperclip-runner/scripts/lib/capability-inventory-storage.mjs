import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeInventory, encodeInventory, renderDocumentation } from "./capability-inventory.mjs";

export async function readInventory(path) {
  const inventory = decodeInventory(await readFile(path, "utf8"));
  if (!inventory.rowFiles) return inventory;
  const { rowFiles, ...metadata } = inventory;
  const parts = await Promise.all(rowFiles.map(file => readFile(resolve(dirname(path), file), "utf8")));
  return { ...metadata, rows: parts.flatMap(part => decodeInventory(part).rows) };
}

export function inventoryOutputs(packageRoot, inventory) {
  const { rows, ...metadata } = inventory;
  const outputs = {};
  const rowFiles = [];
  let part = [];
  function flush() {
    if (!part.length) return;
    const name = `capabilities/part-${String(rowFiles.length + 1).padStart(2, "0")}.yaml`;
    rowFiles.push(name);
    outputs[resolve(packageRoot, "spec/capability", name)] = encodeInventory({ rows: part });
    part = [];
  }
  for (const row of rows) {
    if (Buffer.byteLength(encodeInventory({ rows: [...part, row] })) > 16_000) flush();
    part.push(row);
  }
  flush();
  outputs[resolve(packageRoot, "spec/capability/capabilities.yaml")] = encodeInventory({ ...metadata, rowFiles });
  return outputs;
}

export function documentationOutputs(packageRoot, inventories) {
  const full = renderDocumentation(inventories);
  const start = full.indexOf("## Skill / Reference Rows");
  const end = full.indexOf("## Legacy MCP Alias Index");
  const outputs = {};
  const links = [];
  const rows = inventories.capabilities.rows;
  for (let offset = 0; offset < rows.length; offset += 40) {
    const name = `capability-contract/skills-${Math.floor(offset / 40) + 1}.md`;
    links.push(`- [Skill rows ${offset + 1}–${Math.min(offset + 40, rows.length)}](${name})`);
    outputs[resolve(packageRoot, "docs", name)] = `# Skill / Reference Rows\n\n| Capability | Primary disposition | Source anchor |\n| --- | --- | --- |\n${rows.slice(offset, offset + 40).map(row => `| ${row.id} | ${row.primaryDisposition} | ${row.sourceAnchor} |`).join("\n")}\n`;
  }
  outputs[resolve(packageRoot, "docs/capability-contract/legacy-mcp.md")] = full.slice(end);
  outputs[resolve(packageRoot, "docs/capability-contract.md")] = `${full.slice(0, start)}## Inventory Tables\n\n${links.join("\n")}\n- [Legacy MCP Alias Index](capability-contract/legacy-mcp.md)\n\nThe capability inventory index lists its data files in \`rowFiles\`. Use \`readInventory\` to load all rows.\n`;
  return outputs;
}
