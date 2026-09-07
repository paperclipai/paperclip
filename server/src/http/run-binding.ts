export type RunBinding =
  | { kind: "valid" }
  | { kind: "mismatch"; claimRunId: string; headerRunId: string }
  | { kind: "invalid"; reason: "missing_claim_run_id" };

/**
 * Validate the optional transport run-id against the signed claim. A missing
 * header is valid because the signed claim remains authoritative; a mismatch
 * is explicit and must be audited by the caller before returning 422.
 */
export function validateRunBinding(
  claimRunId: string,
  headerRunId: string | undefined,
): RunBinding {
  const claim = claimRunId.trim();
  if (!claim) return { kind: "invalid", reason: "missing_claim_run_id" };

  const header = headerRunId?.trim();
  if (!header || header === claim) return { kind: "valid" };
  return { kind: "mismatch", claimRunId: claim, headerRunId: header };
}
