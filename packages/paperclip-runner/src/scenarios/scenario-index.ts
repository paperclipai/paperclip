import type { CapabilityWakeReason } from "../mock-core/capability-control-plane-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import type {
  CapabilityScenarioToolPolicy,
  CapabilityToolTaskMode,
} from "../tools/capability-semantic-tool-types.js";
import type {
  CapabilityActorRole,
  CapabilityAssertionClass,
  CapabilityPrimaryDisposition,
  CapabilityScenarioIndex,
  CapabilityScenarioIndexEntry,
  CapabilitySkillElement,
} from "../scenarios/scenario-explorer-types.js";

const GENERATED_HEADER = "# GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory.";

interface CapabilityTraceabilityRow {
  id: string;
  title: string;
  group: string;
  fixture: string;
  sourceAnchor: string;
  skillElements?: CapabilitySkillElement[];
  expectedSemantics?: string[];
  forbiddenSemantics?: string[];
  primaryDisposition: CapabilityPrimaryDisposition;
  requiredGrants?: string[];
  assertionClasses?: CapabilityAssertionClass[];
  evidenceIds?: string[];
  legacyMcpAliases?: string[];
}

/**
 * Deterministic per-scenario execution profile.
 *
 * The Capability traceability manifest carries no actor role, task mode, or
 * catalog claim set, so those three facts are declared here rather than
 * inferred from case prose (UX map §8: "the UI must not infer them"). This
 * table is the normative source the generated scenario index reads.
 */
export interface CapabilityScenarioProfile {
  actorRole: CapabilityActorRole;
  taskMode: CapabilityToolTaskMode;
  wakeReason: CapabilityWakeReason;
  seed: CapabilitySeedKind;
  claims: string[];
  policy?: CapabilityScenarioToolPolicy;
}

export type CapabilitySeedKind =
  | "baseline"
  | "approval_pending"
  | "approval_decided"
  | "blocker_graph"
  | "interaction_pending"
  | "document_draft"
  | "children_done"
  | "skill_test"
  | "comment_wake"
  | "second_actor"
  | "budget_tight"
  | "checkout_conflict"
  | "workspace_service"
  | "deliverable_pending";

const DISCOVERY_CLAIMS = [
  "discovery:tasks:read",
  "discovery:agents:read",
  "discovery:projects:read",
  "discovery:goals:read",
];
const DELEGATION_CLAIMS = ["delegation:tasks:create", "dependencies:write"];
const GOVERNANCE_READ_CLAIMS = ["governance:approvals:read", "governance:approvals:comment"];
const GOVERNANCE_REQUEST_CLAIMS = [...GOVERNANCE_READ_CLAIMS, "governance:approvals:request"];
const GOVERNANCE_DECIDE_CLAIMS = [...GOVERNANCE_REQUEST_CLAIMS, "governance:approvals:decide"];

/**
 * Fixture-level defaults. Every fixture named by the manifest has an entry;
 * `capabilityScenarioProfileCoverage` proves it.
 */
const FIXTURE_PROFILES: Record<string, Partial<CapabilityScenarioProfile>> = {
  "baseline": {},
  "approval-approved": { seed: "approval_decided", claims: GOVERNANCE_DECIDE_CLAIMS, actorRole: "board" },
  "approval-denied": { seed: "approval_decided", claims: GOVERNANCE_READ_CLAIMS },
  "blocked-dedup": { seed: "blocker_graph" },
  "blocker-graph": { seed: "blocker_graph", claims: DELEGATION_CLAIMS },
  "budget-critical": { seed: "budget_tight" },
  "checkout-conflict": { seed: "checkout_conflict" },
  "children-done": { seed: "children_done", claims: DELEGATION_CLAIMS, wakeReason: "blockers_resolved" },
  "continuation-wake": { seed: "interaction_pending", wakeReason: "interaction_resolved" },
  "crossteam": { seed: "second_actor", actorRole: "manager", claims: DISCOVERY_CLAIMS },
  "deliverable-file": { seed: "deliverable_pending" },
  "dependency-blocked-wake": { seed: "blocker_graph", wakeReason: "issue_commented" },
  "done-evidence": { seed: "deliverable_pending" },
  "empty-inbox": {},
  "env-blocked-task": { seed: "workspace_service", claims: ["workspace:read", "workspace:control"] },
  "ephemeral-artifacts-task": { seed: "deliverable_pending" },
  "exec-not-participant": { seed: "second_actor", actorRole: "reviewer" },
  "exec-participant": { seed: "second_actor", actorRole: "reviewer", claims: DISCOVERY_CLAIMS },
  "handback-comment": { seed: "comment_wake", wakeReason: "issue_commented" },
  "issue-detail": {},
  "mcp-approval-gate": { seed: "approval_pending", claims: GOVERNANCE_REQUEST_CLAIMS },
  "mcp-approval-path-missing": { seed: "baseline", claims: GOVERNANCE_READ_CLAIMS },
  "mention-directive": { seed: "comment_wake", wakeReason: "issue_commented" },
  "mention-fyi": { seed: "comment_wake", wakeReason: "issue_commented" },
  "patch-fault-close": { seed: "baseline", wakeReason: "scheduled_retry" },
  "plan-annotations": { seed: "document_draft", taskMode: "planning", wakeReason: "interaction_resolved" },
  "recovery-processlost": { seed: "baseline", wakeReason: "resume" },
  "skill-test-task": {
    seed: "skill_test",
    taskMode: "skill_test",
    claims: ["test:generic_api_request"],
    policy: {
      allowGenericEscapeHatch: true,
      genericEscapeHatchAllowlist: [{ method: "GET", path: "/api/issues/*" }],
    },
  },
  "stale-plan": { seed: "document_draft", taskMode: "planning" },
  "stale-target": { seed: "interaction_pending", wakeReason: "interaction_resolved" },
  "superseded-interaction": { seed: "interaction_pending", wakeReason: "issue_commented" },
  "toolchain-verify-task": { seed: "workspace_service", claims: ["workspace:read", "workspace:control"] },
  "wake-comment": { seed: "comment_wake", wakeReason: "issue_commented" },
};

/** Group-level defaults applied when the fixture default leaves a field open. */
const GROUP_CLAIMS: Record<string, string[]> = {
  se: DISCOVERY_CLAIMS,
  su: DELEGATION_CLAIMS,
  ap: GOVERNANCE_REQUEST_CLAIMS,
  mh: DELEGATION_CLAIMS,
  rf: DISCOVERY_CLAIMS,
};

/**
 * `rf` is the 22-case reference-surface family; its capability set follows the
 * case-ID family segment rather than the group.
 */
const RF_FAMILY_CLAIMS: Array<[string, string[]]> = [
  ["rf-api-", DISCOVERY_CLAIMS],
  ["rf-art-", []],
  ["rf-case-", ["cases:read", "cases:write"]],
  ["rf-cskill-", ["company_skills:read", "company_skills:write"]],
  ["rf-iws-", ["workspace:read", "workspace:control"]],
  ["rf-routine-", ["routines:read", "routines:write"]],
  ["rf-wf-", ["portability:export", "company:admin"]],
];

/** Case-level overrides where the case, not the fixture, sets the posture. */
const CASE_PROFILES: Record<string, Partial<CapabilityScenarioProfile>> = {
  "ix-checkbox-result-01": { claims: DELEGATION_CLAIMS },
  "wk-ask-mode-01": { taskMode: "ask" },
  "wk-plan-directive-01": { taskMode: "planning" },
  "wk-plan-directive-02": { taskMode: "planning" },
  "wk-plan-accepted-01": { taskMode: "planning", wakeReason: "interaction_resolved" },
  "wk-plan-annotation-01": { taskMode: "planning" },
  "wk-resume-delta-01": { wakeReason: "resume" },
  "wk-recovery-processlost-01": { wakeReason: "resume" },
  "rs-question-only-01": { taskMode: "ask", wakeReason: "issue_commented" },
  "rs-secret-hygiene-01": {
    wakeReason: "issue_commented",
    claims: ["secrets:metadata:read", "secrets:values:read"],
    policy: { allowSecretValueAccess: true },
  },
  "bl-create-blocked-01": { claims: DELEGATION_CLAIMS },
  "rs-dependency-blocked-wake-01": { taskMode: "ask", wakeReason: "issue_commented" },
  "mh-plan-confirm-01": { taskMode: "planning", claims: DELEGATION_CLAIMS },
  "ap-approval-wake-01": {
    actorRole: "board",
    claims: GOVERNANCE_DECIDE_CLAIMS,
    wakeReason: "approval_resolved",
  },
  "ap-board-approval-01": { claims: GOVERNANCE_REQUEST_CLAIMS },
  "ap-mcp-gate-01": { claims: GOVERNANCE_READ_CLAIMS },
  "ap-mcp-expiry-01": { claims: GOVERNANCE_REQUEST_CLAIMS },
  "ap-mcp-pathmissing-01": { claims: GOVERNANCE_READ_CLAIMS },
  "rf-api-mgr-heartbeat-01": { actorRole: "manager", claims: DISCOVERY_CLAIMS },
  "rf-api-review-changes-01": { actorRole: "reviewer" },
  "rf-wf-export-preview-01": { actorRole: "board" },
  "rf-wf-invite-01": { actorRole: "board" },
  "rf-wf-project-setup-01": { actorRole: "board" },
};

const DEFAULT_PROFILE: CapabilityScenarioProfile = {
  actorRole: "engineer",
  taskMode: "standard",
  wakeReason: "manual",
  seed: "baseline",
  claims: [],
};

export function capabilityScenarioProfile(row: {
  id: string;
  group: string;
  fixture: string;
}): CapabilityScenarioProfile {
  const fixtureProfile = FIXTURE_PROFILES[row.fixture] ?? {};
  const caseProfile = CASE_PROFILES[row.id] ?? {};
  const actorRole = caseProfile.actorRole ?? fixtureProfile.actorRole ?? DEFAULT_PROFILE.actorRole;
  const taskMode = caseProfile.taskMode ?? fixtureProfile.taskMode ?? DEFAULT_PROFILE.taskMode;
  const claims =
    caseProfile.claims ??
    fixtureProfile.claims ??
    rfFamilyClaims(row.id) ??
    GROUP_CLAIMS[row.group] ??
    DEFAULT_PROFILE.claims;
  return {
    actorRole,
    taskMode,
    wakeReason: caseProfile.wakeReason ?? fixtureProfile.wakeReason ?? DEFAULT_PROFILE.wakeReason,
    seed: caseProfile.seed ?? fixtureProfile.seed ?? DEFAULT_PROFILE.seed,
    claims: liveClaims(claims, taskMode, actorRole),
    policy: caseProfile.policy ?? fixtureProfile.policy,
  };
}

/**
 * Drop grants that cannot unlock anything in this scenario's task mode or for
 * this actor role. A dead grant would render as a claim chip that unlocks no
 * operation, which reads as a policy bug in the Context tab rather than as the
 * task-mode restriction it actually is.
 */
function liveClaims(
  claims: readonly string[],
  taskMode: CapabilityToolTaskMode,
  actorRole: string,
): string[] {
  const live = new Set(claims);
  for (const claim of claims) {
    const usable = CAPABILITY_SEMANTIC_TOOL_CATALOG.some(
      (tool) =>
        tool.requiredClaims.includes(claim) &&
        tool.taskModes.includes(taskMode) &&
        (tool.allowedRoles === undefined || tool.allowedRoles.includes(actorRole)),
    );
    if (!usable) live.delete(claim);
  }
  return [...live].sort();
}

function rfFamilyClaims(id: string): string[] | undefined {
  return RF_FAMILY_CLAIMS.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** Fixtures declared in the profile table, for the coverage assertion. */
export function capabilityScenarioProfileCoverage(): readonly string[] {
  return Object.freeze(Object.keys(FIXTURE_PROFILES).sort());
}

/**
 * Parse the checked-in Capability traceability derivative into the scenario
 * index. Accepts the generated-header prefix so callers can pass the file
 * verbatim (`readFile` in Node, a bundled `?raw` import in the browser).
 */
export function buildCapabilityScenarioIndex(manifestSource: string): CapabilityScenarioIndex {
  const body = manifestSource.startsWith("#")
    ? manifestSource.slice(manifestSource.indexOf("\n") + 1)
    : manifestSource;
  const parsed = JSON.parse(body) as { schemaVersion: number; rows: CapabilityTraceabilityRow[] };
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.rows)) {
    throw new Error("Capability traceability manifest is not schema version 2");
  }
  const entries = parsed.rows
    .map((row) => toEntry(row))
    .sort((left, right) => left.id.localeCompare(right.id));
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
  return Object.freeze({
    schema: "paperclip.capability.scenario-index.v1",
    generatedFrom: "spec/capability/eval-traceability.yaml",
    groups: [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    entries,
  });
}

function toEntry(row: CapabilityTraceabilityRow): CapabilityScenarioIndexEntry {
  const profile = capabilityScenarioProfile(row);
  return {
    id: row.id,
    title: row.title,
    group: row.group,
    fixture: row.fixture,
    actorRole: profile.actorRole,
    taskMode: profile.taskMode,
    wakeReason: profile.wakeReason,
    seedKind: profile.seed,
    primaryDisposition: row.primaryDisposition,
    requiredGrants: [...(row.requiredGrants ?? [])],
    scenarioClaims: profile.claims,
    policy: profile.policy ?? null,
    assertionClasses: [...(row.assertionClasses ?? [])],
    sourceAnchor: row.sourceAnchor,
    skillElements: (row.skillElements ?? []).map((element) => ({ ...element })),
    evidenceIds: [...(row.evidenceIds ?? [])],
    legacyMcpAliases: [...(row.legacyMcpAliases ?? [])],
    expectedSemantics: [...(row.expectedSemantics ?? [])],
    forbiddenSemantics: [...(row.forbiddenSemantics ?? [])],
  };
}

export function capabilityScenarioEntry(
  index: CapabilityScenarioIndex,
  id: string,
): CapabilityScenarioIndexEntry | undefined {
  return index.entries.find((entry) => entry.id === id);
}

export { GENERATED_HEADER as CAPABILITY_MANIFEST_HEADER };
