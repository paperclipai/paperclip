import type {
  CapabilityFixtureState,
  CapabilityJsonValue,
  CapabilityWakeReason,
} from "../mock-core/capability-control-plane-types.js";
import type {
  CapabilityAuthorizationRecord,
  CapabilityScenarioToolPolicy,
  CapabilitySemanticToolDescriptor,
  CapabilityToolTaskMode,
} from "../tools/capability-semantic-tool-types.js";

/**
 * Capability run-artifact contract.
 *
 * The browser scenario explorer is a read surface: every fact it renders has
 * to arrive as one of the records below, all of which are produced by the
 * Capability mock control plane and the Capability authorization engine. The UI
 * never computes exposure, never evaluates a claim, never diffs state, and
 * never judges parity. See `docs/design/capability-scenario-explorer-ux.md` §8
 * ("authority rule").
 */

export type CapabilityPrimaryDisposition =
  | "control_plane_owned"
  | "always_agent_tool"
  | "optional_agent_tool";

export type CapabilityAssertionClass =
  | "control_plane_invariant"
  | "agent_tool_contract"
  | "authorization_policy"
  | "combined_multi_hop"
  | "restraint_no_call";

export type CapabilityParityStatus = "pass" | "fail" | "intentional_gap" | "not_run";

export type CapabilityActorRole = "engineer" | "manager" | "reviewer" | "board";

export interface CapabilitySkillElement {
  file: string;
  section: string;
  lines: string;
}

/** One row of the generated scenario index consumed by the picker. */
export interface CapabilityScenarioIndexEntry {
  id: string;
  title: string;
  group: string;
  fixture: string;
  /** Supplied by the profile table; the UI must never infer it from prose. */
  actorRole: CapabilityActorRole;
  /** Supplied by the profile table; drives task-mode tool exposure. */
  taskMode: CapabilityToolTaskMode;
  wakeReason: CapabilityWakeReason;
  /** Deterministic fixture-seed selector declared by the profile table. */
  seedKind: string;
  primaryDisposition: CapabilityPrimaryDisposition;
  requiredGrants: string[];
  /** Catalog claims the profile grants so the scenario can run at all. */
  scenarioClaims: string[];
  /** Scenario-scoped policy overrides evaluated by the 7D engine. */
  policy: CapabilityScenarioToolPolicy | null;
  assertionClasses: CapabilityAssertionClass[];
  sourceAnchor: string;
  skillElements: CapabilitySkillElement[];
  evidenceIds: string[];
  legacyMcpAliases: string[];
  expectedSemantics: string[];
  forbiddenSemantics: string[];
}

export interface CapabilityScenarioIndex {
  schema: "paperclip.capability.scenario-index.v1";
  generatedFrom: string;
  groups: Array<{ id: string; count: number }>;
  entries: CapabilityScenarioIndexEntry[];
}

export type CapabilityRunMode = "fake" | "codex";

export interface CapabilityRedactionChip {
  path: string;
  replacement: string;
  rule: string;
}

interface CapabilityTimelineBase {
  sequence: number;
  /** Fixture-clock instant. Never a wall clock — see UX map §7. */
  at: string;
  /**
   * Turn this entry belongs to. Turn 0 is the control-plane session seed
   * (checkout, wake routing, initial exposure) that exists before any agent
   * or user input; turns count from 1 in artifact order. The UI groups on
   * this number and never derives turn boundaries itself (7I map §10).
   */
  turn: number;
}

export type CapabilityTimelineEntry =
  | (CapabilityTimelineBase & {
      kind: "user_message";
      channel: "user";
      text: string;
    })
  | (CapabilityTimelineBase & {
      kind: "agent_message";
      channel: "agent";
      text: string;
    })
  | (CapabilityTimelineBase & {
      kind: "semantic_call";
      channel: "agent";
      operationId: string;
      disposition: CapabilityPrimaryDisposition;
      summary: string;
      input: CapabilityJsonValue;
      requiredClaims: string[];
      idempotency: string;
      idempotencyKey: string | null;
      redactions: CapabilityRedactionChip[];
      escapeHatch: boolean;
      authorizationSequence: number;
    })
  | (CapabilityTimelineBase & {
      kind: "semantic_result";
      channel: "agent";
      operationId: string;
      outcome: "committed" | "read" | "duplicate" | "denied" | "absent";
      summary: string;
      value: CapabilityJsonValue;
      failure: { code: string; reason: string } | null;
      redactions: CapabilityRedactionChip[];
      authorizationSequence: number;
      protocolEventRefs: string[];
    })
  | (CapabilityTimelineBase & {
      kind: "control_plane_action";
      channel: "control_plane";
      action: string;
      summary: string;
      detail: CapabilityJsonValue;
      auditRef: string | null;
      decisionRef: string | null;
      stateRevision: number;
    })
  | (CapabilityTimelineBase & {
      kind: "system_note";
      channel: "system";
      note: string;
      forbiddenOperationCount: number;
    });

export interface CapabilityExposureEntry {
  operationId: string;
  title: string;
  requiredClaims: string[];
  /** For optional tools: the claim that unlocked exposure. */
  unlockedBy: string | null;
  reason: string;
}

export interface CapabilityControlPlaneCapability {
  operationId: string;
  reason: string;
}

export interface CapabilityExposure {
  schema: "paperclip.capability.exposure.v1";
  always: CapabilityExposureEntry[];
  optional: CapabilityExposureEntry[];
  controlPlane: CapabilityControlPlaneCapability[];
  /** Operations the catalog defines but this run never exposed. */
  withheld: CapabilityExposureEntry[];
}

export type CapabilityDiffDomain =
  | "tasks"
  | "comments"
  | "documents"
  | "interactions"
  | "approvals"
  | "artifacts"
  | "blockers"
  | "workspace"
  | "budget"
  | "run";

export type CapabilityDiffChangeKind = "added" | "removed" | "changed";

export interface CapabilityDiffFieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface CapabilityDiffRow {
  entityId: string;
  change: CapabilityDiffChangeKind;
  fields: CapabilityDiffFieldChange[];
}

export interface CapabilityDiffDomainSection {
  domain: CapabilityDiffDomain;
  summary: string;
  changed: boolean;
  rows: CapabilityDiffRow[];
  afterSnapshot: CapabilityJsonValue;
}

export interface CapabilityStateDiff {
  schema: "paperclip.capability.state-diff.v1";
  beforeRevision: number;
  afterRevision: number;
  domains: CapabilityDiffDomainSection[];
}

export interface CapabilityParityAssertion {
  index: number;
  assertionClass: CapabilityAssertionClass;
  expectation: string;
  status: CapabilityParityStatus;
  expected: string;
  observed: string;
}

export interface CapabilityForbiddenCheck {
  semantic: string;
  invoked: boolean;
  transcriptSequence: number | null;
}

export interface ScenarioChatntentionalGap {
  subject: string;
  rationale: string;
}

export interface CapabilityParityReport {
  schema: "paperclip.capability.scenario-parity.v1";
  verdict: CapabilityParityStatus;
  assertions: CapabilityParityAssertion[];
  forbidden: CapabilityForbiddenCheck[];
  intentionalGaps: ScenarioChatntentionalGap[];
  legacyBaselineNote: string;
  /**
   * Capability's own verdict for this case when its report artifact was loaded.
   * Rendered as supplied; the explorer never re-judges it.
   */
  evalSuite: {
    available: boolean;
    status: CapabilityParityStatus;
    semanticOperation: string | null;
    authorizationDecision: string | null;
    stateDiff: string[];
  };
}

export interface CapabilityRunArtifact {
  schema: "paperclip.capability.run-artifact.v1";
  scenarioId: string;
  mode: CapabilityRunMode;
  runId: string;
  actor: { id: string; name: string; role: string; capabilityGrants: string[] };
  task: { id: string; identifier: string; title: string; workMode: CapabilityToolTaskMode };
  wake: { reason: CapabilityWakeReason; payload: CapabilityJsonValue };
  budget: { limitCents: number; spentCents: number; remainingCents: number };
  timeline: CapabilityTimelineEntry[];
  exposure: CapabilityExposure;
  authorizationRecords: CapabilityAuthorizationRecord[];
  diff: CapabilityStateDiff;
  parity: CapabilityParityReport;
  /** Harness failure, if the scenario could not be executed to completion. */
  failure: { message: string } | null;
}

/**
 * Scenario chat per-turn record.
 *
 * The chat surface groups evidence by turn, so every fact it groups has to be
 * produced here rather than derived in a component: the runtime owns turn
 * boundaries, per-turn exposure, the per-turn diff, and the per-turn verdict
 * (7I interaction map §10, "data contract extension").
 */
export interface CapabilityChatTurn {
  /** 0 is the control-plane session seed; user turns count from 1. */
  turn: number;
  /** The user text that opened the turn; null for the seed turn. */
  prompt: string | null;
  status: "running" | "settled" | "failed";
  /** Sequence range of this turn's timeline entries, inclusive. */
  firstSequence: number;
  lastSequence: number;
  exposure: CapabilityExposure;
  authorizationRecords: CapabilityAuthorizationRecord[];
  diff: CapabilityStateDiff;
  /**
   * Wake scheduling, blocker resolution, and terminal reconciliation recorded
   * during the turn. Always a subset of the turn's control-plane entries.
   */
  reconciliationEvents: Array<{
    sequence: number;
    action: string;
    summary: string;
    stateRevision: number;
  }>;
  parity: CapabilityParityReport;
  counts: {
    calls: number;
    denied: number;
    controlPlane: number;
    changedDomains: number;
  };
  failure: { message: string } | null;
}

export type CapabilityChatSessionStatus = "idle" | "running" | "settled" | "failed";

/**
 * A chat session artifact is a run artifact plus its turn decomposition. Every
 * session-level record keeps its 7F meaning so the existing explorer panels
 * render it unchanged.
 */
export interface CapabilityChatSessionArtifact extends CapabilityRunArtifact {
  turns: CapabilityChatTurn[];
  status: CapabilityChatSessionStatus;
  /** Scripted turns still available to send, for the replay/primed hints. */
  remainingScriptedTurns: number;
}

export interface CapabilitySnapshotPair {
  before: CapabilityFixtureState;
  after: CapabilityFixtureState;
}

export type CapabilityCatalogTool = CapabilitySemanticToolDescriptor;
