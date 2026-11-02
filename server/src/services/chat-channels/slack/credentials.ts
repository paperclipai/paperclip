import { SLACK_CHAT_BOT_SCOPES } from "@paperclipai/shared";

import {
  unprocessable,
} from "../../../errors.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

const REQUIRED_SLACK_BOT_SCOPES = SLACK_CHAT_BOT_SCOPES;

export async function verifySlackCredentials(
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number,
): Promise<VerifiedProviderIdentity> {
  const response = await fetchImpl("https://slack.com/api/auth.test", {
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${credentials.botToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
  });
  const result = (await response.json()) as {
    ok?: boolean;
    error?: string;
    team_id?: string;
    team?: string;
    user_id?: string;
    user?: string;
  };
  if (!response.ok || !result.ok)
    throw unprocessable(
      `Slack rejected the bot token: ${result.error ?? response.status}`,
    );
  const grantedScopes = new Set(
    (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  const missingScopes = REQUIRED_SLACK_BOT_SCOPES.filter(
    (scope) => !grantedScopes.has(scope),
  );
  if (missingScopes.length > 0) {
    throw unprocessable(
      `Slack app is missing required bot scopes: ${missingScopes.join(", ")}`,
      {
        code: "chat_provider_permissions_missing",
        provider: "slack",
        missingScopes,
      },
    );
  }
  return {
    providerAccountId: result.team_id,
    providerAccountLabel: result.team,
    botExternalId: result.user_id,
    botUsername: result.user,
    botLabel: result.user,
  };
}
