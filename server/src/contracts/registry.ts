import { detectContractTypes } from "./detect.js";
import { PREDICATES } from "./predicates.js";
import type {
  ContractType,
  IssueForContracts,
  CommentForContracts,
  VerificationResult,
} from "./types.js";

export interface ContractViolation {
  contract: ContractType;
  missing: string;
  evidenceQuery: string;
}

export interface ContractEvaluationResult {
  contracts: ContractType[];
  violations: ContractViolation[];
  ok: boolean;
}

/**
 * Evaluates all applicable completion contracts for a given issue.
 * Pure: accepts pre-fetched issue and comments, returns structured result.
 */
export function evaluateContracts(
  issue: IssueForContracts,
  comments: CommentForContracts[],
): ContractEvaluationResult {
  const contracts = detectContractTypes(issue, comments);
  const violations: ContractViolation[] = [];

  for (const contract of contracts) {
    const predicate = PREDICATES[contract];
    const result: VerificationResult = predicate(issue, comments);
    if (!result.ok) {
      violations.push({
        contract,
        missing: result.missing,
        evidenceQuery: result.evidenceQuery,
      });
    }
  }

  return {
    contracts,
    violations,
    ok: violations.length === 0,
  };
}

export { detectContractTypes };
export type { ContractType, VerificationResult, ContractViolation };
