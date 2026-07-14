/**
 * @fileoverview Classifies a failed skill mutation into the four visual states
 * from the Phase 3 UX spec (PAP-13865 / §9.10 Company Skill Policy Contract).
 *
 * The contract inverts the old model: **skill permissions are opt-in
 * restrictions, not opt-in capabilities.** Under the open default there is no
 * permission chrome at all — install / edit / update / test / reset / remove
 * are just live buttons. A denial notice only appears when an explicit company
 * policy (State B) or a non-configurable platform invariant (State C) actually
 * denied the action. Everything else (network, 409 conflict, 5xx) is a
 * transient error (State D) that keeps the existing toast path.
 *
 * This classifier is deliberately pure and framework-free so it can be unit
 * tested exhaustively without a DOM. `classifySkillDenial()` returns `null` for
 * State A (allowed / nothing to show) and State D (transient — let the caller
 * toast it); the UI renders a persistent banner only for B and C.
 */

import { ApiError } from "../api/client";

/** Machine-readable error codes the server attaches to skill mutation failures. */
export const SKILL_POLICY_DENIAL_CODE = "skill_policy_denied";

/**
 * Non-configurable platform-invariant failure codes (§9.10). Policy can never
 * loosen these — the remediation is always to fix the artifact/source/input,
 * never to change a permission or point at Paperclip EE.
 */
export const SKILL_PLATFORM_INVARIANT_CODES = [
  "skill_authentication_required",
  "skill_company_boundary_denied",
  "skill_workspace_boundary_denied",
  "skill_source_validation_failed",
  "skill_unsafe_content_blocked",
  "skill_secret_handling_blocked",
  "skill_actor_restricted",
] as const;

/**
 * Requires board-administration authority (`users:manage_permissions`). This is
 * a platform boundary — not something the current agent can self-serve — so we
 * treat it as State C but with admin-oriented remediation.
 */
export const SKILL_POLICY_ADMIN_CODE = "skill_policy_admin_required";

export type SkillDenialState = "policy" | "platform" | "platform_admin";

export interface SkillDenial {
  /** Which visual treatment applies. `policy` = State B, `platform*` = State C. */
  state: SkillDenialState;
  /** Machine-readable error code from the server, when present. */
  code: string | null;
  /** §9.10 decision `reason`, when the server surfaced the decision shape. */
  reason: string | null;
  /** Plain-language title for the banner. */
  title: string;
  /** Human remediation — never a curl/API-key snippet. */
  remediation: string;
  /**
   * Whether the Paperclip EE affordance is relevant for this denial. Only an
   * explicit company-policy denial (State B) or a policy-admin requirement can
   * be resolved by an administrator via EE. Platform-safety failures never
   * point at EE — policy cannot waive them.
   */
  allowsEeRemediation: boolean;
}

const DEFAULT_POLICY_REMEDIATION =
  "A company administrator can change the skill policy to allow this.";
const DEFAULT_ADMIN_REMEDIATION =
  "This requires company administration access. Ask an administrator to make this change.";

/** Human-readable titles for the platform-invariant codes (State C). */
const PLATFORM_TITLES: Record<string, string> = {
  skill_authentication_required: "Sign in to manage skills.",
  skill_company_boundary_denied: "This skill belongs to another company.",
  skill_workspace_boundary_denied: "This skill source is outside an allowed workspace.",
  skill_source_validation_failed: "This skill source failed validation.",
  skill_unsafe_content_blocked: "This skill contains unsafe content.",
  skill_secret_handling_blocked: "This skill exposes a secret value.",
  skill_actor_restricted: "This action isn't available for the current actor.",
};

/** Default remediation copy per platform-invariant code — framed as a fix, never a grant. */
const PLATFORM_REMEDIATIONS: Record<string, string> = {
  skill_authentication_required: "Sign in and try again.",
  skill_company_boundary_denied: "Open the skill from the company that owns it.",
  skill_workspace_boundary_denied:
    "Import from a configured Paperclip workspace or the company managed-skill directory.",
  skill_source_validation_failed: "Fix the flagged source and retry.",
  skill_unsafe_content_blocked:
    "Remove the fetch-and-execute or unsafe pattern before saving.",
  skill_secret_handling_blocked: "Remove the secret value before saving.",
  skill_actor_restricted: "Retry from an account with access to this action.",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Turn a caller-supplied error into a denial descriptor, or `null` when there
 * is nothing to render as a persistent notice (State A allowed / State D
 * transient). The `actionLabel` (e.g. "Installing external skills") lets the
 * caller phrase State B's title around the specific action.
 */
export function classifySkillDenial(
  error: unknown,
  actionLabel?: string,
): SkillDenial | null {
  if (!(error instanceof ApiError)) return null;

  const body = asRecord(error.body);
  const code = asString(body?.code);
  const reason = asString(body?.reason);
  const remediation = asString(body?.remediation);

  // State B — explicit company-policy denial. Resolvable by an administrator.
  const isPolicyDenial =
    code === SKILL_POLICY_DENIAL_CODE
    || reason === "explicit_rule"
    || reason === "policy_default";
  if (isPolicyDenial) {
    const title = actionLabel
      ? `${actionLabel} is restricted by your company policy.`
      : "This action is restricted by your company policy.";
    return {
      state: "policy",
      code,
      reason,
      title,
      remediation: remediation ?? DEFAULT_POLICY_REMEDIATION,
      allowsEeRemediation: true,
    };
  }

  // State C — policy administration boundary (needs users:manage_permissions).
  if (code === SKILL_POLICY_ADMIN_CODE) {
    return {
      state: "platform_admin",
      code,
      reason,
      title: "This change needs administration access.",
      remediation: remediation ?? DEFAULT_ADMIN_REMEDIATION,
      allowsEeRemediation: true,
    };
  }

  // State C — non-configurable platform-safety invariant. Never waivable.
  const isPlatformInvariant =
    (code !== null && (SKILL_PLATFORM_INVARIANT_CODES as readonly string[]).includes(code))
    || reason === "platform_invariant";
  if (isPlatformInvariant) {
    return {
      state: "platform",
      code,
      reason,
      title: (code && PLATFORM_TITLES[code]) ?? "This action is blocked by a platform safety rule.",
      remediation:
        remediation
        ?? (code && PLATFORM_REMEDIATIONS[code])
        ?? "Fix the flagged issue and try again.",
      allowsEeRemediation: false,
    };
  }

  // State D — transient (network / 409 conflict / 5xx / uncoded 4xx). Let the
  // caller keep the existing retry toast; do not render a policy banner.
  return null;
}
