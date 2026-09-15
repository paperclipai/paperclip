import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const contractPath = resolve(packageRoot, "spec/capability/source-contract.json");
const outputDirectory = resolve(packageRoot, "generated/capability");
const outputPaths = {
  capabilities: resolve(outputDirectory, "capabilities.yaml"),
  tools: resolve(outputDirectory, "mcp-tool-map.yaml"),
  evals: resolve(outputDirectory, "eval-traceability.yaml"),
  overview: resolve(outputDirectory, "capability-contract.md"),
  handoff: resolve(outputDirectory, "downstream-handoff.md"),
};

const checkOnly = process.argv.includes("--check");
const dispositions = new Set(["control_plane_owned", "always_agent_tool", "optional_agent_tool"]);

function sourceAnchor(path, line, heading) {
  return `${path}#L${line}:${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function classifyHeading(path, heading) {
  const normalized = heading.toLowerCase();
  if (/(authentication|identity|checkout|budget|error|wake|heartbeat|approval follow-up|activity|audit|release|terminology)/.test(normalized)) {
    return "control_plane_owned";
  }
  if (/(artifact|comment|document|plan|interaction|final disposition|work product|report|question)/.test(normalized)) {
    return "always_agent_tool";
  }
  if (/(company|agent|project|goal|routine|workspace|approval|case|secret|import|export|skill)/.test(normalized) || path.includes("api-reference")) {
    return "optional_agent_tool";
  }
  return "control_plane_owned";
}

function semanticOperation(disposition, heading) {
  const normalized = heading.toLowerCase();
  if (disposition === "control_plane_owned") return "runtime_reconciliation";
  if (normalized.includes("document") || normalized.includes("plan")) return "write_document";
  if (normalized.includes("comment") || normalized.includes("report")) return "report_progress";
  if (normalized.includes("artifact") || normalized.includes("work product")) return "register_deliverable";
  if (normalized.includes("interaction") || normalized.includes("question")) return "request_human_input";
  return disposition === "always_agent_tool" ? "get_task_context" : "scoped_discovery";
}

async function readSkillHeadings(paths) {
  const rows = [];
  for (const path of paths) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (!match) continue;
      const heading = match[2].trim();
      const disposition = classifyHeading(path, heading);
      rows.push({
        id: `skill:${path}:${index + 1}`,
        kind: "skill_heading",
        sourceAnchor: sourceAnchor(path, index + 1, heading),
        heading,
        primaryDisposition: disposition,
        semanticOperation: semanticOperation(disposition, heading),
        expectedMockState: disposition === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
      });
    }
  }
  return rows;
}

async function readLegacyTools() {
  const path = "packages/mcp-server/src/tools.ts";
  const contents = await readFile(resolve(repositoryRoot, path), "utf8");
  return [...contents.matchAll(/makeTool\(\s*\n?\s*"(paperclip[A-Za-z0-9]+)"/g)].map((match) => ({
    name: match[1],
    sourceAnchor: sourceAnchor(path, contents.slice(0, match.index).split("\n").length, match[1]),
  }));
}

function parseCase(entry, group, contract) {
  const [id, title] = entry.split("|", 2);
  const [primaryDisposition, validationKind, operation, expectedMockState] = contract.evalGroups[group];
  return {
    id,
    title,
    group,
    sourceAnchor: `paperclip-evals/paperclip-skill-optimization/${group}.yaml#${id}`,
    primaryDisposition,
    fixtureProfile: `${group}-baseline`,
    dominantValidationKind: validationKind,
    requiredCapabilityGrants: primaryDisposition === "optional_agent_tool" ? [`${group}:read_or_write`] : [],
    semanticOperation: operation,
    expectedSemanticOperations: operation === "none" ? [] : [operation],
    forbiddenOperations: primaryDisposition === "control_plane_owned" ? ["legacy_mcp_transport"] : [],
    expectedMockState,
    browserEvidenceRecipe: `${group}/${id}`,
  };
}

export function validateRows(rows, label) {
  const ids = new Set();
  const anchors = new Set();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`${label} has a missing or duplicate id: ${row.id ?? "<missing>"}`);
    ids.add(row.id);
    if (!dispositions.has(row.primaryDisposition)) throw new Error(`${label} row ${row.id} has no valid primary disposition`);
    if (!row.sourceAnchor) throw new Error(`${label} row ${row.id} has no source anchor`);
    if (anchors.has(row.sourceAnchor)) throw new Error(`${label} has a duplicate source anchor: ${row.sourceAnchor}`);
    anchors.add(row.sourceAnchor);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderOverview(capabilities, tools, evals) {
  const digest = createHash("sha256").update(stableJson({ capabilities, tools, evals })).digest("hex");
  return [
    "# Capability Capability Contract",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    `- Skill/reference headings: ${capabilities.length}`,
    `- Legacy MCP tools: ${tools.length}`,
    `- Eval cases: ${evals.length} across ${new Set(evals.map((row) => row.group)).size} groups`,
    `- Deterministic content SHA-256: \`${digest}\``,
    "",
    "Every row has exactly one primary disposition, a source anchor, a semantic operation, and a mock-state expectation.",
  ].join("\n") + "\n";
}

function renderHandoff() {
  return [
    "# Capability Downstream Handoff",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    "## Stable Inputs",
    "",
    "- `capabilities.yaml`: every current Paperclip skill and reference heading, including its source anchor, disposition, semantic operation, and mock-state expectation.",
    "- `mcp-tool-map.yaml`: the complete 42-tool legacy MCP replacement map.",
    "- `eval-traceability.yaml`: all 106 corpus cases in 16 groups, including fixtures, grants, operations, state projections, forbids, and browser evidence IDs.",
    "- `contract-schema.json`: required row fields and the closed disposition enum.",
    "",
    "## Consumer Tracks",
    "",
    "- **7B UX interaction map:** use eval `browserEvidenceRecipe`, semantic operation, and expected state to define transcript, authorization, and parity views.",
    "- **7C mock control plane:** implement only the state projections and control-plane-owned operations represented by the generated rows.",
    "- **7D semantic catalog:** use the operation/disposition fields to create always and optional descriptors; control-plane-owned rows stay absent from model tools.",
    "- **7E eval conformance:** import each case by stable ID and assert the declared operation, forbidden operation set, and final mock projection.",
    "- **7F scenario explorer:** index scenarios by the generated evidence recipe and render the linked source anchor, disposition, operation, and mock-state projection.",
    "",
    "`pnpm --dir packages/paperclip-runner check:capability-contract` is the drift gate before consuming these artifacts.",
  ].join("\n") + "\n";
}

async function buildContract() {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const capabilities = await readSkillHeadings(contract.skillSources);
  const discoveredTools = await readLegacyTools();
  const tools = discoveredTools.map((tool) => {
    const mapping = contract.toolMappings[tool.name];
    if (!mapping) throw new Error(`Legacy MCP tool ${tool.name} is unclassified`);
    return {
      id: `mcp:${tool.name}`,
      kind: "legacy_mcp_tool",
      name: tool.name,
      sourceAnchor: tool.sourceAnchor,
      primaryDisposition: mapping[0],
      semanticOperation: mapping[1],
      expectedMockState: mapping[0] === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
    };
  });
  const evals = Object.entries(contract.evalCases).flatMap(([group, entries]) => entries.map((entry) => parseCase(entry, group, contract)));

  validateRows(capabilities, "Skill headings");
  validateRows(tools, "MCP tools");
  validateRows(evals, "Eval cases");
  const discoveredToolNames = new Set(discoveredTools.map((tool) => tool.name));
  for (const mappedToolName of Object.keys(contract.toolMappings)) {
    if (!discoveredToolNames.has(mappedToolName)) throw new Error(`MCP mapping has no registered source tool: ${mappedToolName}`);
  }
  if (tools.length !== 42 || Object.keys(contract.toolMappings).length !== 42) throw new Error(`Expected 42 legacy MCP tools, found ${tools.length}`);
  if (evals.length !== 106 || new Set(evals.map((row) => row.group)).size !== 16) throw new Error(`Expected 106 eval cases in 16 groups, found ${evals.length}`);

  return {
    [outputPaths.capabilities]: stableJson({ schemaVersion: 1, rows: capabilities }),
    [outputPaths.tools]: stableJson({ schemaVersion: 1, rows: tools }),
    [outputPaths.evals]: stableJson({ schemaVersion: 1, rows: evals }),
    [outputPaths.overview]: renderOverview(capabilities, tools, evals),
    [outputPaths.handoff]: renderHandoff(),
  };
}

export async function main() {
  const output = await buildContract();
  for (const [path, contents] of Object.entries(output)) {
    if (checkOnly) {
      if (!existsSync(path) || await readFile(path, "utf8") !== contents) throw new Error(`Generated contract drift: ${relative(packageRoot, path)}`);
    } else {
      await writeFile(path, contents);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
