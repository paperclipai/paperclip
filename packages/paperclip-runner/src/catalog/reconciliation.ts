/**
 * Semantic-catalog reconciliation ledger and drift authority.
 *
 * The single source of truth for the operation list, placement, required
 * claims, and task-mode policy is `./canonical-operations.ts`
 * (`CAPABILITY_CANONICAL_OPERATIONS`). Both catalog modules — `src/tools/`
 * (scenario/eval) and `src/semantic-tools/` (live provider) — now derive their
 * operation set and those facts from it (TASK-17039), so neither can declare an
 * independent list or an independent claim/mode policy.
 *
 * This module is the drift gate on top of that source: it enriches the
 * canonical list with the scenario mock mapping and redaction facts, and it
 * recomputes every remaining metadata divergence between the two catalogs'
 * actual descriptors so a drift check fails on any unrecorded change. After the
 * collapse the only surviving divergence is input-schema *shape*: the live
 * provider schema threads `idempotencyKey` in-band with provider bounds for the
 * model, while the observable scenario runtime threads idempotency out-of-band.
 * That is a single, reviewed projection of one contract, recorded below.
 */
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as SCENARIO_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import type { CapabilityMockCommandMapping } from "../tools/capability-semantic-tool-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as LIVE_CATALOG } from "../semantic-tools/catalog.js";
import {
  CAPABILITY_CANONICAL_OPERATIONS,
  capabilityCanonicalOperation,
  type CapabilityCanonicalOperation,
  type CapabilityRealBindingStatus,
} from "./canonical-operations.js";

export type { CapabilityCatalogSurface, CapabilityRealBindingStatus } from "./canonical-operations.js";

/**
 * The canonical operation enriched with the scenario mock mapping and redaction
 * flag, for consumers and drift tests that assert full per-operation metadata.
 */
export interface CapabilityReconciledOperation extends CapabilityCanonicalOperation {
  /** True when the scenario descriptor declares any redaction rule. */
  readonly redacts: boolean;
  /** Scenario mock-command mapping; `null` for live-only operations. */
  readonly mockCommandMapping: CapabilityMockCommandMapping | null;
}

export type CapabilityCatalogDivergenceField =
  | "requiredClaims"
  | "taskModes"
  | "inputSchemaShape";

export interface CapabilityCatalogDivergence {
  readonly operationId: string;
  readonly field: CapabilityCatalogDivergenceField;
  readonly scenario: string;
  readonly live: string;
  /** Recorded rationale for why the two surfaces legitimately differ today. */
  readonly disposition: string;
}

const scenarioById = new Map(SCENARIO_CATALOG.map((tool) => [tool.operationId, tool]));
const liveById = new Map(LIVE_CATALOG.map((tool) => [tool.operationId as string, tool]));

function enrich(operation: CapabilityCanonicalOperation): CapabilityReconciledOperation {
  const scenario = scenarioById.get(operation.operationId);
  return Object.freeze({
    ...operation,
    redacts: scenario !== undefined && scenario.redaction.length > 0,
    mockCommandMapping: scenario?.mockCommandMapping ?? null,
  });
}

/** The single canonical catalog, enriched with scenario mock/redaction facts. */
export const CAPABILITY_CANONICAL_CATALOG: readonly CapabilityReconciledOperation[] = Object.freeze(
  CAPABILITY_CANONICAL_OPERATIONS.map(enrich),
);

// ---------------------------------------------------------------------------
// Divergence ledger. Placement, required claims, and task modes are now single
// sourced, so those fields cannot diverge. Input-schema shape is the one
// intentional per-surface projection; every entry carries its disposition.
// ---------------------------------------------------------------------------

function inputSchemaShape(
  schema: { properties?: Record<string, unknown>; required?: readonly string[] } | undefined,
): string {
  const properties = Object.keys(schema?.properties ?? {}).sort();
  const required = [...(schema?.required ?? [])].sort();
  return `properties=[${properties.join(",")}] required=[${required.join(",")}]`;
}

/**
 * Input schemas are a single contract projected two ways by design: the live
 * provider descriptor threads `idempotencyKey` in-band and carries provider
 * length/pattern bounds for the model, while the observable scenario runtime
 * threads idempotency out-of-band. This is a reviewed, intentional projection,
 * not two independently authored schemas.
 */
const INPUT_SCHEMA_SHAPE_DISPOSITION =
  "Reviewed intentional projection of one input contract: the live provider descriptor threads idempotencyKey in-band with provider bounds for the model; the observable scenario runtime threads idempotency out-of-band. The operation list, claims, and task modes are single-sourced from canonical-operations.ts.";

function buildDivergences(): readonly CapabilityCatalogDivergence[] {
  const divergences: CapabilityCatalogDivergence[] = [];
  for (const operation of CAPABILITY_CANONICAL_OPERATIONS) {
    const scenario = scenarioById.get(operation.operationId);
    const live = liveById.get(operation.operationId);
    if (scenario === undefined || live === undefined) continue;

    const record = (
      field: CapabilityCatalogDivergenceField,
      scenarioValue: string,
      liveValue: string,
      disposition: string,
    ): void => {
      if (scenarioValue === liveValue) return;
      divergences.push({ operationId: operation.operationId, field, scenario: scenarioValue, live: liveValue, disposition });
    };

    record(
      "requiredClaims",
      [...scenario.requiredClaims].sort().join(","),
      [...live.requiredClaims].sort().join(","),
      "UNRECORDED — required claims are single-sourced from canonical-operations.ts and must not diverge.",
    );
    record(
      "taskModes",
      [...scenario.taskModes].sort().join(","),
      [...live.allowedModes].sort().join(","),
      "UNRECORDED — task modes are single-sourced from canonical-operations.ts and must not diverge.",
    );
    record(
      "inputSchemaShape",
      inputSchemaShape(scenario.inputSchema),
      inputSchemaShape(live.inputSchema),
      INPUT_SCHEMA_SHAPE_DISPOSITION,
    );
  }
  return Object.freeze(divergences);
}

export interface CapabilityCatalogReconciliation {
  readonly unionCount: number;
  readonly scenarioCount: number;
  readonly liveCount: number;
  readonly sharedCount: number;
  readonly scenarioOnly: readonly string[];
  readonly liveOnly: readonly string[];
  readonly byRealBindingStatus: Readonly<Record<CapabilityRealBindingStatus, number>>;
  readonly alwaysCount: number;
  readonly optionalCount: number;
  readonly divergences: readonly CapabilityCatalogDivergence[];
}

export function capabilityCatalogReconciliation(): CapabilityCatalogReconciliation {
  const scenarioIds = new Set(scenarioById.keys());
  const liveIds = new Set(liveById.keys());
  const scenarioOnly = [...scenarioIds].filter((id) => !liveIds.has(id)).sort();
  const liveOnly = [...liveIds].filter((id) => !scenarioIds.has(id)).sort();
  const byRealBindingStatus: Record<CapabilityRealBindingStatus, number> = {
    live_codex: 0,
    scenario_mock: 0,
    test_only: 0,
  };
  let alwaysCount = 0;
  let optionalCount = 0;
  for (const operation of CAPABILITY_CANONICAL_OPERATIONS) {
    byRealBindingStatus[operation.realBindingStatus] += 1;
    if (operation.placement === "always_agent_tool") alwaysCount += 1;
    else if (operation.placement === "optional_agent_tool") optionalCount += 1;
  }
  return {
    unionCount: CAPABILITY_CANONICAL_OPERATIONS.length,
    scenarioCount: scenarioIds.size,
    liveCount: liveIds.size,
    sharedCount: [...scenarioIds].filter((id) => liveIds.has(id)).length,
    scenarioOnly,
    liveOnly,
    byRealBindingStatus,
    alwaysCount,
    optionalCount,
    divergences: buildDivergences(),
  };
}

/** The reconciled operation for one id, or undefined. */
export function capabilityReconciledOperation(
  operationId: string,
): CapabilityReconciledOperation | undefined {
  const operation = capabilityCanonicalOperation(operationId);
  return operation === undefined ? undefined : enrich(operation);
}
