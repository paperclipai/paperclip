import { createSpekoProvider } from "../../voice/speko-provider.js";

import {
  unprocessable,
} from "../../../errors.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export async function verifySpekoCredentials(
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<VerifiedProviderIdentity> {
  if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(credentials.signingSecret ?? "")) throw unprocessable("Speko requires a Standard Webhooks signing secret");
  const identity = await createSpekoProvider(credentials.apiKey, fetchImpl).verifyAgent(credentials.agentId);
  return { providerAccountId: identity.organizationId, providerAccountLabel: "Speko workspace", botExternalId: identity.id, botLabel: identity.name };
}
