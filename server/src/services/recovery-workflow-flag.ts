/**
 * Feature flag: per-company Cloudflare Workflow recovery enablement.
 *
 * PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES   — comma list; companies in AUTHORITY mode
 *   (CF Workflow is authoritative; poll-loop skips them).
 * PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES — comma list; companies in SHADOW mode
 *   (CF Workflow observes alongside the poll-loop; no side-effects).
 *
 * Empty / undefined env ⇒ "off" (all-poll-loop, existing behaviour).
 *
 * Precedence: if a companyId appears in BOTH lists, ACTIVE takes priority.
 */

const ACTIVE_ENV_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES";
const SHADOW_ENV_KEY = "PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES";

function parseCompanyIds(envKey: string): Set<string> {
  const raw = process.env[envKey];
  if (!raw || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Returns the recovery workflow mode for `companyId`:
 * - "active"  — company is in PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES (CF Workflow is authority)
 * - "shadow"  — company is in PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES only
 * - "off"     — not in either list
 *
 * Active takes precedence if the company appears in both lists.
 * Always re-reads env vars so tests can set/unset them freely.
 */
export function getRecoveryWorkflowMode(companyId: string): "off" | "shadow" | "active" {
  if (!companyId) return "off";
  if (parseCompanyIds(ACTIVE_ENV_KEY).has(companyId)) return "active";
  if (parseCompanyIds(SHADOW_ENV_KEY).has(companyId)) return "shadow";
  return "off";
}

/**
 * Back-compat helper: returns true only when the CF Workflow is the AUTHORITY
 * for this company (i.e., mode === "active"). Shadow companies return false.
 *
 * Existing callers (poll-skip gate) depend on this meaning; shadow companies
 * must NOT be skipped by the poll loop.
 */
export function isRecoveryWorkflowEnabled(companyId: string): boolean {
  return getRecoveryWorkflowMode(companyId) === "active";
}
