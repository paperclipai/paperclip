import {
  unprocessable,
} from "../../../errors.js";

import {
  normalizeMicrosoftTeamsCredentialIds,
} from "../../chat-teams-credentials.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export async function verifyTeamsCredentials(credentials: Record<string, string>, fetchImpl: typeof fetch, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number): Promise<VerifiedProviderIdentity> {

    const teamsCredentials = normalizeMicrosoftTeamsCredentialIds(credentials);
    const body = new URLSearchParams({
      client_id: teamsCredentials.clientId,
      client_secret: teamsCredentials.clientSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(teamsCredentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const result = (await response.json()) as {
      access_token?: string;
      error_description?: string;
    };
    if (!response.ok || !result.access_token)
      throw unprocessable(
        `Microsoft rejected the app credentials: ${result.error_description ?? response.status}`,
      );
    return {
      providerAccountId: teamsCredentials.tenantId,
      providerAccountLabel: teamsCredentials.tenantId,
      botExternalId: teamsCredentials.clientId,
    };

}
