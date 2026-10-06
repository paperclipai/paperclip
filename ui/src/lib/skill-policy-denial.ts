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

import { t } from "@/i18n";
import { ApiError } from "../api/client";

/** Machine-readable error codes the server attaches to skill mutation failures. */
export const SKILL_POLICY_DENIAL_CODE = "skill_policy_denied";

/**
 * Non-configurable platform-invariant failure codes (§9.10). Policy can never
 * loosen these — the remediation is always to fix the artifact/source/input,
 * never to change a permission.
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
}

const actionTranslationKeys: Record<string, string> = {
  "Importing skills": "localizationSkills.importingSkills304",
  "Импорт навыков": "localizationSkills.importingSkills304",
  "Scanning projects for skills": "localizationSkills.scanningProjectsForSkills313",
  "Поиск навыков в проектах": "localizationSkills.scanningProjectsForSkills313",
  "Creating a skill": "localizationSkills.creatingASkill319",
  "Создание навыка": "localizationSkills.creatingASkill319",
  "Updating this skill": "localizationSkills.updatingThisSkill333",
  "Обновление навыка": "localizationSkills.updatingThisSkill333",
  "Installing this skill": "localizationSkills.installingThisSkill342",
  "Установка навыка": "localizationSkills.installingThisSkill342",
  "Removing this skill": "localizationSkills.removingThisSkill376",
  "Удаление навыка": "localizationSkills.removingThisSkill376"
};

const defaultPolicyRemediation = () => t("localizationSkills.policyRemediation");
const defaultAdminRemediation = () => t("localizationSkills.adminRemediation");

/** Human-readable titles for the platform-invariant codes (State C). */
const platformTitles = (): Record<string, string> => ({
  skill_authentication_required: t("localizationSkills.skillSignIn"),
  skill_company_boundary_denied: t("localizationSkills.skillOtherOrganization"),
  skill_workspace_boundary_denied: t("localizationSkills.skillOutsideWorkspace"),
  skill_source_validation_failed: t("localizationSkills.skillInvalidSource"),
  skill_unsafe_content_blocked: t("localizationSkills.skillUnsafeContent"),
  skill_secret_handling_blocked: t("localizationSkills.skillExposedSecret"),
  skill_actor_restricted: t("localizationSkills.skillActorRestricted"),
});

/** Default remediation copy per platform-invariant code — framed as a fix, never a grant. */
const platformRemediations = (): Record<string, string> => ({
  skill_authentication_required: t("localizationSkills.signInRetry"),
  skill_company_boundary_denied: t("localizationSkills.openOwningOrganization"),
  skill_workspace_boundary_denied:
    t("localizationSkills.importAllowedWorkspace"),
  skill_source_validation_failed: t("localizationSkills.fixSourceRetry"),
  skill_unsafe_content_blocked:
    t("localizationSkills.removeUnsafePattern"),
  skill_secret_handling_blocked: t("localizationSkills.removeSecretBeforeSave"),
  skill_actor_restricted: t("localizationSkills.retryAuthorizedAccount"),
});

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
    return {
      state: "policy",
      code,
      reason,
      get title() {
        const action = actionLabel && actionTranslationKeys[actionLabel]
          ? t(actionTranslationKeys[actionLabel])
          : actionLabel;
        return action
          ? t("localizationSkills.policyRestrictedNamedAction", { action })
          : t("localizationSkills.policyRestrictedAction");
      },
      get remediation() { return remediation ?? defaultPolicyRemediation(); },
    };
  }

  // State C — policy administration boundary (needs users:manage_permissions).
  if (code === SKILL_POLICY_ADMIN_CODE) {
    return {
      state: "platform_admin",
      code,
      reason,
      get title() { return t("localizationSkills.changeNeedsAdmin"); },
      get remediation() { return remediation ?? defaultAdminRemediation(); },
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
      get title() {
        return (code && platformTitles()[code]) ?? t("localizationSkills.platformSafetyBlocked");
      },
      get remediation() {
        return remediation
          ?? (code && platformRemediations()[code])
          ?? t("localizationSkills.fixIssueRetry");
      },
    };
  }

  // State D — transient (network / 409 conflict / 5xx / uncoded 4xx). Let the
  // caller keep the existing retry toast; do not render a policy banner.
  return null;
}
