import { microsoftTeamsCredentialIdSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const MICROSOFT_TEAMS_ID_FIELDS = ["clientId", "tenantId"] as const;

/**
 * Keep the persisted Teams identity in the same canonical form Microsoft puts
 * in Bot Framework activities. This is also called inside the service so
 * direct service consumers cannot bypass the HTTP validator.
 */
export function normalizeMicrosoftTeamsCredentialIds(
  credentials: Record<string, string>,
): Record<string, string> {
  const normalized = { ...credentials };
  for (const field of MICROSOFT_TEAMS_ID_FIELDS) {
    const parsed = microsoftTeamsCredentialIdSchema.safeParse(
      normalized[field],
    );
    if (!parsed.success) {
      throw unprocessable(`${field} must be a canonical Microsoft Entra UUID`, {
        code: "chat_provider_credentials_invalid",
        provider: "microsoft-teams",
        field,
      });
    }
    normalized[field] = parsed.data;
  }
  return normalized;
}

/**
 * Bot Framework can vary the casing of the same Entra object id between
 * activities. Keep that case-insensitive identity on one Paperclip principal,
 * while retaining the adapter's opaque user id when the activity omits a
 * usable Entra id (for example, some federated or anonymous participants).
 */
export function normalizeMicrosoftTeamsExternalPrincipalId(
  aadObjectId: unknown,
  fallbackId: string,
): string {
  const parsed = microsoftTeamsCredentialIdSchema.safeParse(aadObjectId);
  return parsed.success ? parsed.data : fallbackId;
}
