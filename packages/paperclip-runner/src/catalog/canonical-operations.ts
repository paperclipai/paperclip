/**
 * Canonical semantic-operation registry — the single source of truth.
 *
 * The runner historically carried two independently hand-maintained semantic
 * catalogs:
 *
 * - `src/tools/` — the rich scenario/eval descriptor (placement, side-effect
 *   class, idempotency, redaction, mock mapping) consumed by the scenario and
 *   conformance layers and exported as the package-root default.
 * - `src/semantic-tools/` — the live runtime engine (catalog + policy +
 *   dispatcher) that drives live Codex, the issue-thread projection, and the
 *   generated provider-neutral contracts.
 *
 * PAP-17025 froze a machine-readable authority over the union of both surfaces.
 * PAP-17039 performs the physical collapse: this module hand-authors the
 * 41-operation union exactly once, and **both** catalog modules now derive
 * their operation list, placement, required claims, and task-mode policy from
 * it. Neither catalog declares an independent operation list or an independent
 * claim/mode policy any longer — they only supply per-surface presentation
 * (title, description, input/output schema, and the scenario-only mock mapping
 * and redaction rules).
 *
 * Divergences the collapse resolved (see `spec/capability/catalog-reconciliation.md`):
 *
 * 1. `generic_api_request` now carries a single claim, `test:generic_api_request`.
 * 2. Task modes follow one canonical policy: the live runtime exposure policy
 *    unioned with `skill_test`, so every operation the eval harness must drive
 *    is drivable while the live runtime keeps its intended per-mode exposure.
 * 3. Placement (`always`/`optional`), required claims, and allowed roles are
 *    single-sourced here; the two catalogs can no longer disagree on them.
 *
 * The only surviving cross-surface difference is input-schema *shape*: the live
 * provider schema threads `idempotencyKey` in-band with provider bounds for the
 * model, while the observable scenario runtime threads idempotency out-of-band.
 * That is a single reviewed projection of one contract, not two independent
 * schemas — recorded as an intentional disposition in the reconciliation ledger.
 */

import type {
  CapabilitySideEffectClass,
  CapabilityToolDisposition,
  CapabilityOptionalCatalogGroup,
  CapabilityToolTaskMode,
  ScenarioChatdempotencyBehavior,
} from "../tools/capability-semantic-tool-types.js";

/** Which catalog surface(s) project this operation. */
export type CapabilityCatalogSurface = "scenario" | "live";

/** Where an operation is executable today, before real Paperclip binding. */
export type CapabilityRealBindingStatus = "live_codex" | "scenario_mock" | "test_only";

export interface CapabilityCanonicalOperation {
  readonly operationId: string;
  /** Catalog surface(s) that project this operation today. */
  readonly surfaces: readonly CapabilityCatalogSurface[];
  readonly placement: CapabilityToolDisposition;
  /** Scenario optional-catalog group; `null` for always tools and live-only ops. */
  readonly optionalGroup: CapabilityOptionalCatalogGroup | null;
  readonly requiredClaims: readonly string[];
  readonly taskModes: readonly CapabilityToolTaskMode[];
  readonly allowedRoles?: readonly string[];
  readonly sideEffectClass: CapabilitySideEffectClass;
  readonly idempotency: ScenarioChatdempotencyBehavior;
  /** Live-only exposure flag; kept off the tool surface until explicitly enabled. */
  readonly disabledByDefault: boolean;
  readonly realBindingStatus: CapabilityRealBindingStatus;
  /**
   * No semantic operation is bound to a real Paperclip service yet; the mock is
   * the only backend (real-service binding is deliverable G of PAP-17016).
   */
  readonly realServiceBinding: "unbound";
  /** Intended PRP evidence family carrying this operation's effect. */
  readonly prpEvidence: string;
  /** The formal PRP expressiveness proof is deliverable C; entries stay pending. */
  readonly prpBindingStatus: "audit_pending";
  /** Legacy MCP alias ids folded into this operation, if any. */
  readonly legacyAliases: readonly string[];
  readonly note?: string;
}

const ALL_MODES: readonly CapabilityToolTaskMode[] = ["standard", "ask", "planning", "skill_test"];
const WORK_MODES: readonly CapabilityToolTaskMode[] = ["standard", "planning", "skill_test"];
const STANDARD_MODES: readonly CapabilityToolTaskMode[] = ["standard", "skill_test"];
const TEST_MODES: readonly CapabilityToolTaskMode[] = ["skill_test"];

function prpEvidenceForSideEffect(sideEffectClass: CapabilitySideEffectClass): string {
  switch (sideEffectClass) {
    case "read":
      return "read projection surfaced via a tool-result item event; no control-plane state diff";
    case "task_write":
      return "semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events";
    case "company_write":
      return "semantic-operation item event plus company-entity state diff and audit record";
    case "governance":
      return "approval lifecycle plus governed-wait continuation and audit events";
    case "workspace_control":
      return "workspace service lifecycle event";
    case "secret_read":
      return "redacted tool-result item event; secret value never reaches the wire";
    case "admin":
      return "company admin/portability item event plus audit record";
    case "test_escape_hatch":
      return "test-only; excluded from product PRP evidence";
    default:
      return "audit_pending";
  }
}

/** Compact authoring row; the exported catalog fills in derived fields. */
interface Row {
  readonly operationId: string;
  readonly surfaces: readonly CapabilityCatalogSurface[];
  readonly placement: CapabilityToolDisposition;
  readonly optionalGroup?: CapabilityOptionalCatalogGroup;
  readonly requiredClaims?: readonly string[];
  readonly taskModes: readonly CapabilityToolTaskMode[];
  readonly allowedRoles?: readonly string[];
  readonly sideEffectClass: CapabilitySideEffectClass;
  readonly idempotency: ScenarioChatdempotencyBehavior;
  readonly disabledByDefault?: boolean;
  readonly realBindingStatus: CapabilityRealBindingStatus;
  readonly legacyAliases?: readonly string[];
  readonly note?: string;
}

const SHARED: readonly CapabilityCatalogSurface[] = ["scenario", "live"];
const SCENARIO_ONLY: readonly CapabilityCatalogSurface[] = ["scenario"];
const LIVE_ONLY: readonly CapabilityCatalogSurface[] = ["live"];

// ---------------------------------------------------------------------------
// The single canonical operation list. One row per union operation. Task modes
// follow the canonical policy (live runtime exposure policy ∪ `skill_test`);
// scenario-only and live-only operations keep their single existing policy
// because there is no second surface to reconcile against.
// ---------------------------------------------------------------------------

const ROWS: readonly Row[] = [
  // --- always-present active-task surface ---
  { operationId: "get_task_context", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipMe"] },
  { operationId: "get_task_history", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "list_documents", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "read_document", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "list_document_revisions", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "report_progress", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipAddComment"] },
  { operationId: "answer_status_question", surfaces: SHARED, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "write_document", surfaces: SHARED, placement: "always_agent_tool", taskModes: WORK_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "request_human_input", surfaces: SHARED, placement: "always_agent_tool", taskModes: WORK_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "register_deliverable", surfaces: SHARED, placement: "always_agent_tool", taskModes: WORK_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "finish_task", surfaces: SHARED, placement: "always_agent_tool", taskModes: STANDARD_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "block_task", surfaces: SHARED, placement: "always_agent_tool", taskModes: STANDARD_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "request_review", surfaces: SHARED, placement: "always_agent_tool", taskModes: STANDARD_MODES, sideEffectClass: "task_write", idempotency: "required", realBindingStatus: "live_codex" },
  {
    operationId: "inspect_operation_result", surfaces: SCENARIO_ONLY, placement: "always_agent_tool", taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none",
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only re-read of a prior operation result; the live dispatcher returns results inline.",
  },

  // --- discovery ---
  { operationId: "search_tasks", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "discovery", requiredClaims: ["discovery:tasks:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipListIssues"] },
  { operationId: "list_agents", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "discovery", requiredClaims: ["discovery:agents:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipListAgents"] },
  {
    operationId: "get_agent", surfaces: LIVE_ONLY, placement: "optional_agent_tool", requiredClaims: ["discovery:agents:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none",
    realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipGetAgent"],
    note: "Live-only single-actor read; the scenario suite covers actor discovery through list_agents.",
  },
  { operationId: "list_projects", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "discovery", requiredClaims: ["discovery:projects:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet." },
  { operationId: "list_goals", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "discovery", requiredClaims: ["discovery:goals:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet." },

  // --- delegation & dependencies ---
  { operationId: "create_task", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "delegation_dependencies", requiredClaims: ["delegation:tasks:create"], taskModes: STANDARD_MODES, sideEffectClass: "company_write", idempotency: "required", realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipCreateIssue"] },
  { operationId: "set_dependencies", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "delegation_dependencies", requiredClaims: ["dependencies:write"], taskModes: STANDARD_MODES, sideEffectClass: "company_write", idempotency: "required", realBindingStatus: "live_codex" },

  // --- governance ---
  { operationId: "list_approvals", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "governance", requiredClaims: ["governance:approvals:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "request_approval", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "governance", requiredClaims: ["governance:approvals:request"], taskModes: STANDARD_MODES, sideEffectClass: "governance", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "decide_approval", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "governance", requiredClaims: ["governance:approvals:decide"], taskModes: STANDARD_MODES, allowedRoles: ["board", "approver", "security"], sideEffectClass: "governance", idempotency: "required", realBindingStatus: "live_codex" },
  { operationId: "comment_on_approval", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "governance", requiredClaims: ["governance:approvals:comment"], taskModes: ALL_MODES, sideEffectClass: "governance", idempotency: "required", realBindingStatus: "live_codex" },
  {
    operationId: "get_approval", surfaces: LIVE_ONLY, placement: "optional_agent_tool", requiredClaims: ["governance:approvals:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none",
    realBindingStatus: "live_codex",
    note: "Live-only single-approval read; the scenario suite covers approvals through list_approvals.",
  },
  {
    operationId: "get_approval_context", surfaces: LIVE_ONLY, placement: "optional_agent_tool", requiredClaims: ["governance:approvals:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none",
    realBindingStatus: "live_codex",
    note: "Live-only approval-plus-linked-tasks read; no scenario counterpart.",
  },

  // --- workspace runtime ---
  { operationId: "get_workspace_runtime", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "workspace_runtime", requiredClaims: ["workspace:read"], taskModes: ALL_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "live_codex" },
  { operationId: "control_workspace_service", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "workspace_runtime", requiredClaims: ["workspace:control"], taskModes: STANDARD_MODES, sideEffectClass: "workspace_control", idempotency: "required", realBindingStatus: "live_codex" },

  // --- control-plane wake scheduling (live-only) ---
  {
    operationId: "schedule_wake", surfaces: LIVE_ONLY, placement: "optional_agent_tool", requiredClaims: ["control_plane:wakes"], taskModes: STANDARD_MODES, sideEffectClass: "task_write", idempotency: "required",
    realBindingStatus: "live_codex",
    note: "Bounded, deterministic mock wake scheduling; requires the control_plane:wakes claim. Live-only continuation primitive.",
  },

  // --- scenario-only optional surfaces (mock extensions, no live binding) ---
  { operationId: "list_cases", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "cases", requiredClaims: ["cases:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "upsert_case", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "cases", requiredClaims: ["cases:write"], taskModes: STANDARD_MODES, sideEffectClass: "company_write", idempotency: "required", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "list_routines", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "routines", requiredClaims: ["routines:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "manage_routine", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "routines", requiredClaims: ["routines:write"], taskModes: STANDARD_MODES, sideEffectClass: "admin", idempotency: "required", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "list_company_skills", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "company_skills", requiredClaims: ["company_skills:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "sync_company_skills", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "company_skills", requiredClaims: ["company_skills:write"], taskModes: STANDARD_MODES, sideEffectClass: "admin", idempotency: "required", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "list_secret_metadata", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "secrets", requiredClaims: ["secrets:metadata:read"], taskModes: STANDARD_MODES, sideEffectClass: "read", idempotency: "none", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension; metadata only." },
  {
    operationId: "read_secret_value", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "secrets", requiredClaims: ["secrets:values:read"], taskModes: STANDARD_MODES, sideEffectClass: "secret_read", idempotency: "none",
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only mock extension; secret value redacted from every observable sink.",
  },
  { operationId: "export_company", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "portability_admin", requiredClaims: ["portability:export"], taskModes: STANDARD_MODES, sideEffectClass: "admin", idempotency: "required", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  { operationId: "administer_company", surfaces: SCENARIO_ONLY, placement: "optional_agent_tool", optionalGroup: "portability_admin", requiredClaims: ["company:admin"], taskModes: STANDARD_MODES, allowedRoles: ["board", "ceo", "admin"], sideEffectClass: "admin", idempotency: "required", realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },

  // --- test-only escape hatch (shared, never product coverage) ---
  {
    operationId: "generic_api_request", surfaces: SHARED, placement: "optional_agent_tool", optionalGroup: "test_escape_hatch", requiredClaims: ["test:generic_api_request"], taskModes: TEST_MODES, sideEffectClass: "test_escape_hatch", idempotency: "required", disabledByDefault: true,
    realBindingStatus: "test_only",
    note: "Test-only escape hatch; explicitly cannot count as product capability coverage (PAP-17016 deliverable D). Single unified claim test:generic_api_request.",
  },
];

function buildOperation(row: Row): CapabilityCanonicalOperation {
  return Object.freeze({
    operationId: row.operationId,
    surfaces: Object.freeze([...row.surfaces]),
    placement: row.placement,
    optionalGroup: row.optionalGroup ?? null,
    requiredClaims: Object.freeze([...(row.requiredClaims ?? [])]),
    taskModes: Object.freeze([...row.taskModes]),
    ...(row.allowedRoles === undefined ? {} : { allowedRoles: Object.freeze([...row.allowedRoles]) }),
    sideEffectClass: row.sideEffectClass,
    idempotency: row.idempotency,
    disabledByDefault: row.disabledByDefault ?? false,
    realBindingStatus: row.realBindingStatus,
    realServiceBinding: "unbound",
    prpEvidence: prpEvidenceForSideEffect(row.sideEffectClass),
    prpBindingStatus: "audit_pending",
    legacyAliases: Object.freeze([...(row.legacyAliases ?? [])]),
    ...(row.note === undefined ? {} : { note: row.note }),
  });
}

/** The single canonical catalog: the union of both surfaces, sorted by id. */
export const CAPABILITY_CANONICAL_OPERATIONS: readonly CapabilityCanonicalOperation[] = Object.freeze(
  [...ROWS].map(buildOperation).sort((left, right) => left.operationId.localeCompare(right.operationId)),
);

const byId = new Map(CAPABILITY_CANONICAL_OPERATIONS.map((operation) => [operation.operationId, operation]));
if (byId.size !== CAPABILITY_CANONICAL_OPERATIONS.length) {
  throw new Error("duplicate canonical semantic operation id");
}

export function capabilityCanonicalOperation(
  operationId: string,
): CapabilityCanonicalOperation | undefined {
  return byId.get(operationId);
}

/** Canonical operations projected onto one catalog surface, sorted by id. */
export function capabilityCanonicalOperationsForSurface(
  surface: CapabilityCatalogSurface,
): readonly CapabilityCanonicalOperation[] {
  return CAPABILITY_CANONICAL_OPERATIONS.filter((operation) => operation.surfaces.includes(surface));
}

/** Convenience for docs/generators: the canonical operation-id list, sorted. */
export function capabilityCanonicalOperationIds(): readonly string[] {
  return CAPABILITY_CANONICAL_OPERATIONS.map((operation) => operation.operationId);
}
