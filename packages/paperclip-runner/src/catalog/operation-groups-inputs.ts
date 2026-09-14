import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_SEMANTIC_TOOL_CATALOG as LIVE_CATALOG } from "../semantic-tools/catalog.js";
import { CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS } from "../tools/capability-semantic-tool-types.js";
import {
  CAPABILITY_CANONICAL_CATALOG,
  capabilityCatalogReconciliation,
} from "./reconciliation.js";
import type {
  LegacyAliasRow,
  OperationGroupsInput,
  OperationGroupsScenario,
  OperationGroupsSource,
} from "./operation-groups-doc.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface EnumSchema {
  properties?: Record<string, { enum?: string[] }>;
}

interface ScenarioManifest {
  rows: OperationGroupsScenario[];
}

interface LegacyAliasManifest {
  rows: LegacyAliasRow[];
}

interface GeneratedContract {
  name: string;
  annotations?: { operationId?: string };
}

interface SourceContract {
  toolMappings: Record<string, readonly [string, string]>;
}

export function loadOperationGroupsInput(): OperationGroupsInput {
  const source = readJson<OperationGroupsSource>("spec/operation-groups/source.json");
  const eventSchema = readJson<EnumSchema>("protocol/schemas/event.schema.json");
  const commandSchema = readJson<EnumSchema>("protocol/schemas/command.schema.json");
  const scenarioManifest = readHeaderJson<ScenarioManifest>("spec/capability/eval-traceability.yaml");
  const aliasManifest = readHeaderJson<LegacyAliasManifest>("spec/capability/mcp-tool-map.yaml");
  const generatedContracts = readJson<GeneratedContract[]>(
    "generated/capability/semantic-tool-contracts.json",
  );
  const sourceContract = readJson<SourceContract>("spec/capability/source-contract.json");
  const eventTypes = eventSchema.properties?.eventType?.enum;
  const commandTypes = commandSchema.properties?.type?.enum;
  if (eventTypes === undefined || commandTypes === undefined) {
    throw new Error("PRP event/command schemas do not expose their canonical enums.");
  }
  return {
    source,
    canonicalOperations: CAPABILITY_CANONICAL_CATALOG,
    reconciliation: capabilityCatalogReconciliation(),
    controlPlaneOperationIds: CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS,
    liveCatalogOperationIds: LIVE_CATALOG.map((operation) => operation.operationId),
    generatedContractOperationIds: generatedContracts.map(
      (contract) => contract.annotations?.operationId ?? contract.name,
    ),
    scenarios: scenarioManifest.rows,
    eventTypes,
    commandTypes,
    legacyAliases: aliasManifest.rows,
    sourceContractToolMappings: sourceContract.toolMappings,
    rootIndexSource: readText("src/index.ts"),
    catalogIndexSource: readText("src/catalog/index.ts"),
  };
}

export function operationGroupsPackageRoot(): string {
  return packageRoot;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

function readHeaderJson<T>(relativePath: string): T {
  const source = readText(relativePath);
  const body = source.startsWith("#") ? source.slice(source.indexOf("\n") + 1) : source;
  return JSON.parse(body) as T;
}
