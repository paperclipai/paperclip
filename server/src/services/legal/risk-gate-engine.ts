import type {
  GateEvaluationContext,
  GateFiring,
  ProfileDefinition,
  ProfileGateConfig,
  RiskGateDefinition,
  RiskGateTrigger,
} from "./types.js";

/**
 * Decide whether a trigger fires for a given evaluation context.
 *
 * A trigger is a disjunction across its fields — any one of `artifact_kind`,
 * `action`, or `keyword_in_deliverable` matches independently. Returns the
 * first matching field for audit-log clarity.
 */
function matchTrigger(
  trigger: RiskGateTrigger,
  context: GateEvaluationContext,
): string | null {
  if (trigger.artifact_kind && trigger.artifact_kind === context.artifactKind) {
    return `artifact_kind=${trigger.artifact_kind}`;
  }
  if (trigger.action && trigger.action === context.action) {
    return `action=${trigger.action}`;
  }
  if (trigger.keyword_in_deliverable && context.deliverableText) {
    const text = context.deliverableText.toLowerCase();
    for (const keyword of trigger.keyword_in_deliverable) {
      if (text.includes(keyword.toLowerCase())) {
        return `keyword_in_deliverable=${keyword}`;
      }
    }
  }
  return null;
}

/**
 * Resolve a `_resolved_from` path expression like
 * `active_profile.risk_gates.filing.approver` against the active profile.
 *
 * Only the `active_profile.*` prefix is supported in v1; any other root
 * returns `undefined`. The path traverses object keys; arrays are not
 * supported. This is intentionally minimal — risk-gate YAMLs only need
 * the profile-bound approver + auto_block today.
 */
function resolveFromPath(path: string, profile: ProfileDefinition): unknown {
  const segments = path.split(".");
  if (segments[0] !== "active_profile") return undefined;
  let cursor: unknown = profile;
  for (let i = 1; i < segments.length; i += 1) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segments[i]!];
  }
  return cursor;
}

/**
 * Evaluate every loaded gate against the action context. Returns an entry
 * per gate that fires. Empty array means no gate fires and the action
 * proceeds without intervention.
 *
 * Note: this is pure evaluation — it does not insert into legal_approvals or
 * legal_risk_gate_events. The caller is responsible for persistence.
 */
export function evaluateGates(
  context: GateEvaluationContext,
  gates: Record<string, RiskGateDefinition>,
  profile: ProfileDefinition,
): GateFiring[] {
  const firings: GateFiring[] = [];
  for (const gate of Object.values(gates)) {
    let matchedTrigger: string | null = null;
    for (const trigger of gate.triggers) {
      matchedTrigger = matchTrigger(trigger, context);
      if (matchedTrigger) break;
    }
    if (!matchedTrigger) {
      // Budget gate fires off the costUsd field even when no explicit trigger
      // declares it (the YAML approach is keyed by gate identity rather than
      // numerical thresholds). Match by gate key as a fallback.
      if (gate.gate === "budget-threshold" && typeof context.costUsd === "number") {
        const profileGate = profile.risk_gates[gate.gate];
        if (
          profileGate &&
          typeof profileGate.threshold_usd === "number" &&
          context.costUsd >= profileGate.threshold_usd
        ) {
          matchedTrigger = `cost_usd>=${profileGate.threshold_usd}`;
        }
      }
    }
    if (!matchedTrigger) continue;

    const approver = resolveFromPath(gate.approval.approver_resolved_from, profile);
    const autoBlock = gate.approval.auto_block_resolved_from
      ? resolveFromPath(gate.approval.auto_block_resolved_from, profile)
      : (profile.risk_gates[gate.gate]?.auto_block ?? true);

    if (typeof approver !== "string") {
      throw new Error(
        `Profile '${profile.profile}' does not resolve approver for gate '${gate.gate}' (path: ${gate.approval.approver_resolved_from})`,
      );
    }

    const profileGate: ProfileGateConfig | undefined =
      profile.risk_gates[gate.gate];

    firings.push({
      gateKey: gate.gate,
      matchedTrigger,
      approverRole: approver,
      autoBlock: typeof autoBlock === "boolean" ? autoBlock : true,
      rationale: profileGate?.rationale,
      evidenceRequired: gate.evidence_required ?? [],
      approvalCardTemplate: gate.approval.approval_card_template,
      hardBlocks: gate.hard_blocks ?? [],
    });
  }
  return firings;
}
