export const CLEANUP_VERIFICATION_KEY = "paperclipCleanupVerification";
export const CLEANUP_VERIFICATION_SCHEMA = "paperclip.cleanup-verification.v1";
export const CLEANUP_ROW_STAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

/** Provider-supplied metadata cannot create host verification evidence. */
export function withoutCleanupVerification(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { [CLEANUP_VERIFICATION_KEY]: _ignored, ...rest } = metadata;
  return rest;
}

export function cleanupRowStamp(alias: string): string {
  return `to_char(${alias}.updated_at AT TIME ZONE 'UTC', '${CLEANUP_ROW_STAMP_FORMAT}')`;
}

/** Fixed aliases only; never interpolate request input into these predicates. */
export function verifiedResourceCleanup(alias: string, kind: "lease" | "image_setup"): string {
  const proof = `${alias}.metadata->'${CLEANUP_VERIFICATION_KEY}'`;
  const company = kind === "lease" ? `${alias}.company_id::text`
    : `COALESCE(NULLIF(btrim(${alias}.metadata->>'setupRpcCompanyId'), ''), 'instance')`;
  return `jsonb_typeof(${proof}) = 'object'
    AND ${proof}->>'schema' = '${CLEANUP_VERIFICATION_SCHEMA}' AND ${proof}->>'kind' = '${kind}'
    AND ${proof}->>'resourceId' = ${alias}.id::text AND ${proof}->>'companyId' = ${company}
    AND ${proof}->>'environmentId' = ${alias}.environment_id::text
    AND ${proof}->>'provider' = ${alias}.provider
    AND ${proof}->>'providerLeaseId' = ${alias}.provider_lease_id
    AND ${alias}.provider_lease_id IS NOT NULL AND ${alias}.provider_lease_id <> ''
    AND ${proof}->>'state' = 'destroyed'
    AND ${proof}->>'rowUpdatedAt' = ${cleanupRowStamp(alias)}
    ${kind === "lease" ? `AND ${proof} ? 'heartbeatRunId'
      AND ${proof}->'heartbeatRunId' = COALESCE(to_jsonb(${alias}.heartbeat_run_id::text), 'null'::jsonb)` : ""}`;
}
