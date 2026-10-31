import {
  unprocessable,
} from "../../../errors.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export async function verifyTelegramCredentials(
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number,
): Promise<VerifiedProviderIdentity> {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getMe`,
    { signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS) },
  );
  const result = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { id?: number; username?: string; first_name?: string };
  };
  if (!response.ok || !result.ok)
    throw unprocessable(
      `Telegram rejected the bot token: ${result.description ?? response.status}`,
    );
  return {
    providerAccountId: String(result.result?.id ?? ""),
    botExternalId: String(result.result?.id ?? ""),
    botUsername: result.result?.username,
    botLabel: result.result?.first_name,
  };
}
