import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildInventories,
  buildSkillInventory,
  decodeInventory,
  encodeInventory,
  renderContractModule,
  renderDocumentation,
  validateInventorySchema,
  validateInventories,
} from "./lib/capability-inventory.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const skillsOnly = process.argv.includes("--skills-only");

async function findEvalRoot() {
  if (process.env.PAPERCLIP_EVALS_ROOT !== undefined) return process.env.PAPERCLIP_EVALS_ROOT;
  const candidates = [
    resolve(repoRoot, "../paperclip-evals/paperclip-skill-optimization"),
    resolve(repoRoot, "../../../../paperclip-evals/paperclip-skill-optimization"),
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Paperclip eval corpus not found. Set PAPERCLIP_EVALS_ROOT. Checked:\n${candidates.join("\n")}`);
}

const outputPaths = {
  capabilities: resolve(packageRoot, "spec/capability/capabilities.yaml"),
  evaluations: resolve(packageRoot, "spec/capability/eval-traceability.yaml"),
  legacyMcpAliases: resolve(packageRoot, "spec/capability/mcp-tool-map.yaml"),
  contract: resolve(packageRoot, "src/generated/capability-contract.ts"),
  documentation: resolve(packageRoot, "docs/capability-contract.md"),
};

const inventories = skillsOnly
  ? {
      capabilities: await buildSkillInventory(repoRoot),
      evaluations: decodeInventory(await readFile(outputPaths.evaluations, "utf8")),
      legacyMcpAliases: decodeInventory(await readFile(outputPaths.legacyMcpAliases, "utf8")),
    }
  : await buildInventories({ repoRoot, evalRoot: await findEvalRoot() });
const inventorySchema = JSON.parse(await readFile(resolve(packageRoot, "spec/capability/inventory.schema.json"), "utf8"));
const errors = [
  ...validateInventorySchema(inventories, inventorySchema),
  ...validateInventories(inventories),
];
if (errors.length > 0) throw new Error(`Capability inventory generation failed:\n${errors.join("\n")}`);

const outputs = {
  [outputPaths.capabilities]: encodeInventory(inventories.capabilities),
  ...(!skillsOnly ? {
    [outputPaths.evaluations]: encodeInventory(inventories.evaluations),
    [outputPaths.legacyMcpAliases]: encodeInventory(inventories.legacyMcpAliases),
  } : {}),
  [outputPaths.contract]: renderContractModule(inventories),
  [outputPaths.documentation]: renderDocumentation(inventories),
};

if (process.argv.includes("--check")) {
  const stale = [];
  for (const [path, content] of Object.entries(outputs)) {
    if (await readFile(path, "utf8").catch(() => "") !== content) stale.push(path);
  }
  if (stale.length > 0) throw new Error(`Capability generated outputs are stale:\n${stale.join("\n")}`);
  process.stdout.write("Capability inventories and generated contract match the canonical baselines.\n");
} else {
  await Promise.all(Object.entries(outputs).map(async ([path, content]) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }));
  process.stdout.write("Generated Capability inventories, TypeScript contract, and documentation.\n");
}
