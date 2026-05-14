/**
 * Wiring layer between the pure `evidence-gate.ts` evaluator and the
 * `issues.ts` PATCH handler (BLO-4824 / BLO-4461 Phase 1).
 *
 * Kept separate from the evaluator so the evaluator stays IO-free (and
 * therefore trivially unit-testable), and separate from `issues.ts` so the
 * wiring is unit-testable too — `runEvidenceGate` takes a `fetch` callback
 * that the production caller wires to live DB queries and the test caller
 * wires to a hard-coded fixture.
 */

import {
  evaluateEvidence,
  type EvidenceCommentLite,
  type EvidenceVerdict,
} from "./evidence-gate.js";
import { DEFAULT_EVIDENCE_REGISTRY } from "./evidence-shapes.js";

export interface EvidenceFetchResult {
  description: string | null;
  labels: Array<{ name: string }>;
  comments: EvidenceCommentLite[];
  workProducts: Array<{
    type: string;
    metadata: Record<string, unknown> | null;
    status: string | null;
  }>;
}

export type FetchEvidenceForGate = (
  issueId: string,
) => Promise<EvidenceFetchResult>;

export interface EvidenceVerdictRecord {
  verdict: EvidenceVerdict;
  missing: string[];
  evidenceFound: string[];
  unlabeledFallback: boolean;
  evaluatedAt: string;
}

/**
 * Run the gate for one issue. Returns the verdict record the caller should
 * persist to `issues.lastEvidenceVerdict`. Caller is responsible for
 * deciding what to do with the verdict (Phase 1: record only; Phase 2:
 * throw on `block`).
 *
 * Work-product `type` → evaluator `kind` mapping is intentional: the
 * evaluator's input shape is its own contract, not tied to the DB's column
 * naming. Mapping at this layer keeps the evaluator portable.
 *
 * Work-product `status` → evaluator `result` mapping treats the DB's status
 * as the canonical pass/fail signal. Producers writing work_products should
 * use status === "pass" for an e2e-run that succeeded — see BLO-4826's
 * skill guidance for how agents are expected to populate this.
 */
export async function runEvidenceGate(
  fetch: FetchEvidenceForGate,
  issueId: string,
  now: Date = new Date(),
): Promise<EvidenceVerdictRecord> {
  const data = await fetch(issueId);
  const evaluation = evaluateEvidence({
    issue: {
      description: data.description,
      labels: data.labels,
    },
    comments: data.comments,
    workProducts: data.workProducts.map((wp) => ({
      kind: wp.type,
      metadata: wp.metadata,
      result: wp.status,
    })),
    registry: DEFAULT_EVIDENCE_REGISTRY,
  });
  return {
    verdict: evaluation.verdict,
    missing: evaluation.missing,
    evidenceFound: evaluation.evidenceFound,
    unlabeledFallback: evaluation.unlabeledFallback,
    evaluatedAt: now.toISOString(),
  };
}
