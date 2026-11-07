import { HttpError } from "../../../errors.js";
import type { createChatCredentials } from "../credentials.js";
import { SlackCloudReceiptError } from "./cloud-event.js";

type Resolver = ReturnType<typeof createChatCredentials>["resolveCredentials"];

export async function resolveSlackCloudSigningSecret(resolve: Resolver, ...args: Parameters<Resolver>): Promise<string> {
  let credentials: Record<string, string>;
  try {
    credentials = await resolve(...args);
  } catch (error) {
    if (error instanceof HttpError && [400, 401, 403, 404, 422].includes(error.status))
      throw new SlackCloudReceiptError("signing_credential_unavailable", "attention");
    throw error;
  }
  if (!credentials.signingSecret) throw new SlackCloudReceiptError("signing_credential_unavailable", "attention");
  return credentials.signingSecret;
}
