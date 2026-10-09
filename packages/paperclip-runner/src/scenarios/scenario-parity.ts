import type { CapabilityAuthorizationRecord } from "../tools/capability-semantic-tool-types.js";
import type {
  CapabilityAssertionClass,
  CapabilityExposure,
  CapabilityForbiddenCheck,
  ScenarioChatntentionalGap,
  CapabilityParityAssertion,
  CapabilityParityReport,
  CapabilityParityStatus,
  CapabilityScenarioIndexEntry,
  CapabilityStateDiff,
  CapabilityTimelineEntry,
} from "../scenarios/scenario-explorer-types.js";

/**
 * Parity judgement for one scenario run.
 *
 * This runs in the runtime layer, never in a component: the explorer renders
 * the verdict it is handed and never recomputes an assertion (UX map §10).
 * When the Capability conformance report is available its per-case verdict is
 * carried through verbatim as an additional, clearly-labelled record.
 */

export interface CapabilityEvalSuiteCaseResult {
  caseId: string;
  semanticOperation?: string;
  authorizationDecision?: string;
  stateDiff?: string[];
}

export type CapabilityEvalSuiteLookup = (caseId: string) => CapabilityEvalSuiteCaseResult | undefined;

export interface CapabilityParityInput {
  entry: CapabilityScenarioIndexEntry;
  timeline: readonly CapabilityTimelineEntry[];
  authorizationRecords: readonly CapabilityAuthorizationRecord[];
  diff: CapabilityStateDiff;
  exposure: CapabilityExposure;
  failure: { message: string } | null;
  evalSuite?: CapabilityEvalSuiteLookup;
}

/**
 * Forbidden eval semantics are HTTP shapes. This table maps a path fragment to
 * the semantic operations that would produce it, so "never invoked" is a real
 * check against the recorded transcript rather than an assumption.
 */
const FORBIDDEN_OPERATION_MAP: Array<[RegExp, string[]]> = [
  [/\/comments/, ["report_progress", "answer_status_question", "comment_on_approval"]],
  [/\/documents/, ["write_document"]],
  [/\/interactions/, ["request_human_input"]],
  [/\/(artifacts|work-products|attachments)/, ["register_deliverable"]],
  [/\/approvals/, ["request_approval", "decide_approval", "comment_on_approval", "list_approvals"]],
  [/\/secrets/, ["read_secret_value", "list_secret_metadata"]],
  [/\/routines/, ["list_routines", "manage_routine"]],
  [/\/cases/, ["list_cases", "upsert_case"]],
  [/\/(workspaces|services)/, ["get_workspace_runtime", "control_workspace_service"]],
  [/\/agents/, ["list_agents"]],
  [/\/skills/, ["list_company_skills", "sync_company_skills"]],
  [/\/export/, ["export_company"]],
  [/\/issues/, ["create_task", "finish_task", "block_task", "request_review", "set_dependencies", "search_tasks"]],
];

export function capabilityScenarioParity(input: CapabilityParityInput): CapabilityParityReport {
  const { entry, timeline, authorizationRecords, diff, exposure, failure } = input;
  const calls = timeline.filter(
    (item): item is Extract<CapabilityTimelineEntry, { kind: "semantic_call" }> =>
      item.kind === "semantic_call",
  );
  const results = timeline.filter(
    (item): item is Extract<CapabilityTimelineEntry, { kind: "semantic_result" }> =>
      item.kind === "semantic_result",
  );
  const controlPlaneEntries = timeline.filter((item) => item.kind === "control_plane_action");
  const invokedOperations = new Set(calls.map((call) => call.operationId));

  const forbidden = entry.forbiddenSemantics.map<CapabilityForbiddenCheck>((semantic) => {
    const candidates = FORBIDDEN_OPERATION_MAP.find(([pattern]) => pattern.test(semantic))?.[1] ?? [];
    const violating = calls.find((call) => candidates.includes(call.operationId));
    return {
      semantic,
      invoked: violating !== undefined,
      transcriptSequence: violating?.sequence ?? null,
    };
  });

  const assertions: CapabilityParityAssertion[] = [];
  const intentionalGaps: ScenarioChatntentionalGap[] = [];
  const classes = new Set<CapabilityAssertionClass>(entry.assertionClasses);

  const push = (
    assertionClass: CapabilityAssertionClass,
    expectation: string,
    ok: boolean,
    expected: string,
    observed: string,
  ): void => {
    assertions.push({
      index: assertions.length + 1,
      assertionClass,
      expectation,
      status: ok ? "pass" : "fail",
      expected,
      observed,
    });
  };

  if (classes.has("control_plane_invariant")) {
    push(
      "control_plane_invariant",
      "Control-plane capabilities are performed by the runtime with no agent tool.",
      controlPlaneEntries.length > 0 && exposure.controlPlane.length > 0,
      "at least one control-plane action and one declared control-plane-owned capability",
      `${controlPlaneEntries.length} control-plane actions · ${exposure.controlPlane.length} capabilities with no tool`,
    );
  }

  if (classes.has("agent_tool_contract")) {
    const typed = results.length === calls.length;
    push(
      "agent_tool_contract",
      "Every semantic call returns a typed result from the catalog contract.",
      typed && calls.length > 0,
      `${calls.length} typed results for ${calls.length} calls`,
      `${results.length} typed results for ${calls.length} calls`,
    );
  }

  if (classes.has("authorization_policy")) {
    const consistent = authorizationRecords.every(
      (record) => record.outcome !== "allowed" || record.missingClaims.length === 0,
    );
    const covered = new Set(authorizationRecords.map((record) => record.operationId));
    const uncovered = calls.filter((call) => !covered.has(call.operationId));
    const denials = authorizationRecords.filter((record) => record.outcome !== "allowed").length;
    push(
      "authorization_policy",
      "Every invocation carries an authorization record and no allowed call had a missing claim.",
      consistent && uncovered.length === 0 && authorizationRecords.length >= calls.length,
      `an authorization record for each of ${calls.length} calls, 0 allowed calls with missing claims`,
      `${authorizationRecords.length} authorization records for ${calls.length} calls · ${denials} not allowed`,
    );
  }

  if (classes.has("combined_multi_hop")) {
    const changedDomains = diff.domains.filter((domain) => domain.changed);
    push(
      "combined_multi_hop",
      "The scenario chains more than one operation across more than one entity domain.",
      calls.length >= 2 && changedDomains.length >= 2,
      "at least 2 semantic calls across at least 2 changed domains",
      `${calls.length} calls · ${changedDomains.length} changed domains (${changedDomains
        .map((domain) => domain.domain)
        .join(", ")})`,
    );
  }

  if (classes.has("restraint_no_call")) {
    const violations = forbidden.filter((check) => check.invoked);
    push(
      "restraint_no_call",
      "No forbidden operation was invoked.",
      violations.length === 0,
      `0 of ${forbidden.length} forbidden operations invoked`,
      violations.length === 0
        ? `0 of ${forbidden.length} forbidden operations invoked`
        : violations.map((check) => check.semantic).join(", "),
    );
    if (forbidden.length === 0) {
      intentionalGaps.push({
        subject: "restraint_no_call",
        rationale:
          "The traceability row records no forbidden semantics, so restraint is proven by the absence of state writes rather than by a forbidden-operation list.",
      });
    }
  }

  push(
    "agent_tool_contract",
    "Every grant the scenario requires unlocked at least one exposed operation.",
    entry.scenarioClaims.every((claim) =>
      [...exposure.always, ...exposure.optional].some((tool) => tool.requiredClaims.includes(claim)),
    ) || entry.scenarioClaims.length === 0,
    entry.scenarioClaims.length === 0
      ? "no scenario claims required"
      : `${entry.scenarioClaims.length} claims each unlocking an exposed operation`,
    `${exposure.optional.length} optional operations exposed from ${entry.scenarioClaims.length} claims`,
  );

  if (entry.legacyMcpAliases.length > 0) {
    intentionalGaps.push({
      subject: "legacy MCP aliases",
      rationale: `${entry.legacyMcpAliases.length} legacy MCP tool names (${entry.legacyMcpAliases.join(
        ", ",
      )}) are mapped for traceability only; Capability exposes semantic operations, not the legacy tool surface.`,
    });
  }

  const evalResult = input.evalSuite?.(entry.id);
  const evalSuite: CapabilityParityReport["evalSuite"] = {
    available: evalResult !== undefined,
    status: evalResult === undefined ? "not_run" : "pass",
    semanticOperation: evalResult?.semanticOperation ?? null,
    authorizationDecision: evalResult?.authorizationDecision ?? null,
    stateDiff: [...(evalResult?.stateDiff ?? [])],
  };

  const verdict: CapabilityParityStatus =
    failure !== null || assertions.some((assertion) => assertion.status === "fail")
      ? "fail"
      : assertions.length === 0
        ? "intentional_gap"
        : "pass";

  return {
    schema: "paperclip.capability.scenario-parity.v1",
    verdict,
    assertions,
    forbidden,
    intentionalGaps,
    legacyBaselineNote: `Eval source ${entry.sourceAnchor} records the skill-present/skill-absent baseline for ${entry.id}.`,
    evalSuite,
  };
}

/**
 * Parity judgement for one chat turn (Scenario chat).
 *
 * A turn is judged on what that turn did, not on the scenario's whole
 * expectation set: a session-level assertion about an operation the board has
 * not asked for yet would read as a failure of turn 1 rather than as work still
 * to come. Turns that did no agent work carry no assertions and report
 * `not_run` — the seed turn is control-plane work, and saying "pass" about it
 * would be a verdict nobody made. The session verdict stays
 * `capabilityScenarioParity` over the cumulative timeline.
 */
export function capabilityTurnParity(input: CapabilityParityInput): CapabilityParityReport {
  const { entry, timeline, authorizationRecords, diff, failure } = input;
  const calls = timeline.filter(
    (item): item is Extract<CapabilityTimelineEntry, { kind: "semantic_call" }> =>
      item.kind === "semantic_call",
  );
  const results = timeline.filter(
    (item): item is Extract<CapabilityTimelineEntry, { kind: "semantic_result" }> =>
      item.kind === "semantic_result",
  );
  const controlPlaneEntries = timeline.filter((item) => item.kind === "control_plane_action");

  const forbidden = entry.forbiddenSemantics.map<CapabilityForbiddenCheck>((semantic) => {
    const candidates = FORBIDDEN_OPERATION_MAP.find(([pattern]) => pattern.test(semantic))?.[1] ?? [];
    const violating = calls.find((call) => candidates.includes(call.operationId));
    return {
      semantic,
      invoked: violating !== undefined,
      transcriptSequence: violating?.sequence ?? null,
    };
  });

  const assertions: CapabilityParityAssertion[] = [];
  const push = (
    assertionClass: CapabilityAssertionClass,
    expectation: string,
    ok: boolean,
    expected: string,
    observed: string,
  ): void => {
    assertions.push({
      index: assertions.length + 1,
      assertionClass,
      expectation,
      status: ok ? "pass" : "fail",
      expected,
      observed,
    });
  };

  if (calls.length > 0) {
    push(
      "agent_tool_contract",
      "Every semantic call in this turn returned a typed result.",
      results.length === calls.length,
      `${calls.length} typed results for ${calls.length} calls`,
      `${results.length} typed results for ${calls.length} calls`,
    );
    const covered = new Set(authorizationRecords.map((record) => record.operationId));
    const uncovered = calls.filter((call) => !covered.has(call.operationId));
    const consistent = authorizationRecords.every(
      (record) => record.outcome !== "allowed" || record.missingClaims.length === 0,
    );
    const denials = authorizationRecords.filter((record) => record.outcome !== "allowed").length;
    push(
      "authorization_policy",
      "Every invocation in this turn carries an authorization record and no allowed call had a missing claim.",
      consistent && uncovered.length === 0,
      `an authorization record for each of ${calls.length} calls, 0 allowed calls with missing claims`,
      `${authorizationRecords.length} authorization records for ${calls.length} calls · ${denials} not allowed`,
    );
  }

  if (controlPlaneEntries.length > 0) {
    push(
      "control_plane_invariant",
      "Control-plane work in this turn was performed by the runtime with no agent tool.",
      controlPlaneEntries.every((item) => item.channel === "control_plane"),
      `${controlPlaneEntries.length} control-plane actions attributed to the control plane`,
      `${controlPlaneEntries.length} control-plane actions attributed to the control plane`,
    );
  }

  if (entry.forbiddenSemantics.length > 0) {
    const violations = forbidden.filter((check) => check.invoked);
    push(
      "restraint_no_call",
      "No forbidden operation was invoked in this turn.",
      violations.length === 0,
      `0 of ${forbidden.length} forbidden operations invoked`,
      violations.length === 0
        ? `0 of ${forbidden.length} forbidden operations invoked`
        : violations.map((check) => check.semantic).join(", "),
    );
  }

  const changedDomains = diff.domains.filter((domain) => domain.changed).length;
  const verdict: CapabilityParityStatus =
    failure !== null || assertions.some((assertion) => assertion.status === "fail")
      ? "fail"
      : assertions.length === 0
        ? "not_run"
        : "pass";

  return {
    schema: "paperclip.capability.scenario-parity.v1",
    verdict,
    assertions,
    forbidden,
    intentionalGaps: [],
    legacyBaselineNote: `Turn-scoped verdict for ${entry.id} · ${calls.length} semantic ${
      calls.length === 1 ? "call" : "calls"
    } · ${changedDomains} changed ${
      changedDomains === 1 ? "domain" : "domains"
    }. The session verdict is judged over the whole transcript.`,
    evalSuite: {
      available: false,
      status: "not_run",
      semanticOperation: null,
      authorizationDecision: null,
      stateDiff: [],
    },
  };
}

/** Builds an eval-suite lookup from a loaded Capability parity report. */
export function capabilityEvalSuiteLookup(report: unknown): CapabilityEvalSuiteLookup {
  const results =
    typeof report === "object" && report !== null && Array.isArray((report as { results?: unknown }).results)
      ? ((report as { results: CapabilityEvalSuiteCaseResult[] }).results)
      : [];
  const byId = new Map(results.map((result) => [result.caseId, result]));
  return (caseId) => byId.get(caseId);
}
