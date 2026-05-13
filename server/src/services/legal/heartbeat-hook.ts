import type { GateEvaluationContext, GateFiring } from "./types.js";
import type { LegalRuntime } from "./legal-runtime.js";

/**
 * Minimal log surface — accepts pino-style (obj, msg) calls. Lets tests pass a
 * stub recorder without pulling pino into the unit test.
 */
export interface PreActionGateLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
}

/**
 * Run a pre-action legal-layer gate evaluation. Logging-only in this PR — no
 * blocking, no DB writes. The caller invokes this immediately before the agent
 * action it is about to take (e.g., adapter.execute).
 *
 * If `legalLayer` is undefined the function is a no-op (legacy paperclip-style
 * deployments). If `legalLayer.evaluate` throws, the error is logged and the
 * function returns without rethrowing — gate evaluation must never block the
 * adapter path in this PR.
 *
 * Returns the firings array for tests / observability; callers in this PR
 * discard it. PR sprint-1/persist-gate-events will wire firings into
 * legal_approvals / legal_risk_gate_events writes and add enforcement.
 */
export function evaluatePreActionGate(
  legalLayer: LegalRuntime | undefined,
  context: GateEvaluationContext,
  log: PreActionGateLogger,
  extraLogFields: Record<string, unknown> = {},
): GateFiring[] {
  if (!legalLayer) return [];
  try {
    const firings = legalLayer.evaluate(context);
    log.info(
      {
        ...extraLogFields,
        agentId: context.agentId,
        action: context.action,
        firingsCount: firings.length,
        firings: firings.map((f) => ({
          gateKey: f.gateKey,
          approverRole: f.approverRole,
          autoBlock: f.autoBlock,
        })),
      },
      "[legal-layer] pre-action gate evaluation",
    );
    return firings;
  } catch (err) {
    log.error(
      { ...extraLogFields, err, agentId: context.agentId, action: context.action },
      "[legal-layer] pre-action gate evaluation threw; continuing without blocking",
    );
    return [];
  }
}
