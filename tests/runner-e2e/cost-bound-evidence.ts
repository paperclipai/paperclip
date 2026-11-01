import { createHash } from "node:crypto";

export interface EvalCostBoundEvidence {
  version: 1;
  scope: "full_lifecycle";
  evidenceSha256: string;
  configurationSha256: string;
}
export interface EvalReservationBound {
  basis: "model_limits" | "operating_allowance";
  evidence: EvalCostBoundEvidence;
  calculationSha256: string;
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function validateCostBoundEvidence(value: EvalCostBoundEvidence): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["version", "scope", "evidenceSha256", "configurationSha256"].includes(key))
      || value.version !== 1 || value.scope !== "full_lifecycle" || !hash(value.evidenceSha256) || !hash(value.configurationSha256)) {
    throw new Error("Invalid reviewed cost bound evidence");
  }
}

export function costBoundConfigurationSha256(calculation: unknown): string {
  return createHash("sha256").update(JSON.stringify(calculation, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex");
}

export function reservationBound(basis: EvalReservationBound["basis"], evidence: EvalCostBoundEvidence, calculation: unknown): EvalReservationBound {
  validateCostBoundEvidence(evidence);
  const calculationSha256 = costBoundConfigurationSha256(calculation);
  if (calculationSha256 !== evidence.configurationSha256) throw new Error("Reviewed cost bound configuration changed");
  return { basis, evidence: structuredClone(evidence), calculationSha256 };
}

export function validateReservationBound(value: EvalReservationBound, infrastructure: boolean): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["basis", "evidence", "calculationSha256"].includes(key))
      || value.basis !== (infrastructure ? "operating_allowance" : "model_limits") || !hash(value.calculationSha256)) {
    throw new Error("Invalid reservation bound");
  }
  validateCostBoundEvidence(value.evidence);
  if (value.calculationSha256 !== value.evidence.configurationSha256) throw new Error("Reviewed cost bound configuration changed");
}
