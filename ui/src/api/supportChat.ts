import {
  supportChatSessionSchema,
  type SupportChatSession,
} from "@paperclipai/shared";
import { api, ApiError } from "./client";

/**
 * Ask the server whether this instance serves the Plain support chat surface.
 *
 * Resolves `null` when the surface is disabled (404 on self-hosted
 * instances), when the caller is not signed in (401/403), or when the
 * response fails the shared contract. The response carries `emailHash` — a
 * bearer credential for the customer's chat identity — so the request opts
 * out of the browser HTTP cache and callers must never persist or log the
 * payload.
 */
export async function fetchSupportChatSession(): Promise<SupportChatSession | null> {
  let payload: unknown;
  try {
    payload = await api.get<unknown>("/support-chat/session", { cache: "no-store" });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      return null;
    }
    throw err;
  }
  const parsed = supportChatSessionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
