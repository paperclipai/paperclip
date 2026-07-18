/**
 * Copy contract for responsible-user ("on behalf of") authorization denials.
 *
 * When an agent run acts on behalf of a human user, authorization is the
 * intersection of the agent's permissions and that user's permissions
 * (see PAP-12447 / PAP-12459). When the intersection denies, the authz layer
 * emits one of the codes below (`AuthorizationDecision.code` in
 * `server/src/services/authorization.ts`). This module is the single source of
 * truth for how those codes are explained to humans, so every surface that
 * renders an agent-call failure uses consistent, actionable language.
 *
 * Terminology is deliberate: always "on behalf of {user}" / "responsible user",
 * never "impersonate".
 */

export const RESPONSIBLE_USER_DENIAL_CODES = [
  "RESPONSIBLE_USER_UNAUTHORIZED",
  "RESPONSIBLE_USER_UNAVAILABLE",
] as const;

export type ResponsibleUserDenialCode = (typeof RESPONSIBLE_USER_DENIAL_CODES)[number];

export type ResponsibleUserDenialTone = "unauthorized" | "unavailable";

export interface ResponsibleUserDenialCopy {
  code: ResponsibleUserDenialCode;
  tone: ResponsibleUserDenialTone;
  /** Short heading, e.g. for a banner title. */
  title: string;
  /** One or two sentences explaining what happened and why. */
  description: string;
  /** What the reader should do next. */
  recommendedAction: string;
}

export function isResponsibleUserDenialCode(
  code: string | null | undefined,
): code is ResponsibleUserDenialCode {
  return (
    code === "RESPONSIBLE_USER_UNAUTHORIZED" || code === "RESPONSIBLE_USER_UNAVAILABLE"
  );
}

/**
 * Render a stable label for the responsible user. Falls back to a generic
 * noun when the display name is unknown, so copy never shows a raw id.
 */
export function responsibleUserLabel(userName: string | null | undefined): string {
  const trimmed = userName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "the responsible user";
}

/**
 * Describe a responsible-user denial for display. `userName` is the responsible
 * user's display name when known; when omitted, generic phrasing is used.
 *
 * These two codes are distinct from a plain agent-lacks-permission denial: here
 * the *agent* is allowed but the *human this run acts for* is not (or is no
 * longer available). Callers should keep the existing generic agent-permission
 * copy for denials whose code is neither of these.
 */
export function describeResponsibleUserDenial(
  code: ResponsibleUserDenialCode,
  options: { userName?: string | null } = {},
): ResponsibleUserDenialCopy {
  const who = responsibleUserLabel(options.userName);

  if (code === "RESPONSIBLE_USER_UNAVAILABLE") {
    return {
      code,
      tone: "unavailable",
      title: "Responsible user unavailable",
      description:
        `This run acts on behalf of ${who}, but that account was removed or ` +
        `deactivated, so its permissions can no longer be evaluated. The agent's ` +
        `own permissions are not enough on their own — every action still requires ` +
        `an active responsible user.`,
      recommendedAction:
        `Mark the work blocked and reassign a responsible user (or reactivate the ` +
        `account) before the agent continues.`,
    };
  }

  return {
    code,
    tone: "unauthorized",
    title: "Responsible user not authorized",
    description:
      `This action was denied because ${who} — the user this run acts on behalf ` +
      `of — does not have permission to perform it. The agent may be allowed, but ` +
      `a run can never exceed the permissions of the user it acts for, so the ` +
      `action is blocked.`,
    recommendedAction:
      `Grant ${who} the required permission, or have someone who is authorized ` +
      `take this action instead.`,
  };
}
