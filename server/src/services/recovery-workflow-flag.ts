/**
 * Feature flag: per-company Cloudflare Workflow recovery enablement.
 *
 * Read from `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` — a comma-separated list of
 * company IDs for which the CF Workflow is the authority (poll-loop skips them).
 * Empty / undefined ⇒ no company enabled (all-shadow / poll-loop-only behaviour).
 */

const ENV_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES";

function getEnabledCompanyIds(): Set<string> {
  const raw = process.env[ENV_KEY];
  if (!raw || !raw.trim()) return new Set();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(ids);
}

/**
 * Returns `true` only when `companyId` is listed in the
 * `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` env allowlist.
 *
 * Always re-reads the env var so tests can set / unset it freely.
 */
export function isRecoveryWorkflowEnabled(companyId: string): boolean {
  if (!companyId) return false;
  return getEnabledCompanyIds().has(companyId);
}
