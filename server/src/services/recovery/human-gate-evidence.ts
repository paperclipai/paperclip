import { sql, type SQL } from "drizzle-orm";

export const OWNER_GONE_ATTESTATION_KEY = "ownerGoneAttestation";

export const HUMAN_GATE_EVIDENCE_KEYS = ["executionReconciliation", OWNER_GONE_ATTESTATION_KEY, "explicitUserContinuation"] as const;

export function humanGateEvidencePredicate(evidence: SQL | unknown): SQL {
  return sql`(${evidence} ?| array[${sql.join(HUMAN_GATE_EVIDENCE_KEYS.map(key => sql`${key}`), sql`, `)}])`;
}

export function hasHumanGateEvidence(evidence: Record<string, unknown> | null | undefined): boolean {
  return Boolean(evidence) && HUMAN_GATE_EVIDENCE_KEYS.some(key => Object.hasOwn(evidence!, key));
}
