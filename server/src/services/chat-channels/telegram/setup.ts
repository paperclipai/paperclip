import { createTelegramMaintenance } from "./maintenance.js";
import type { EndpointRow, RuntimeContext } from "../runtime-types.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import type { Db } from "@paperclipai/db";

import type {
  ConfigureChatEndpointInput,
} from "@paperclipai/shared";

import {
  unprocessable,
} from "../../../errors.js";

import type { EndpointRecord } from "../runtime-types.js";

type TelegramSetupOptions = {
  fetchImpl: typeof globalThis.fetch;
  getWebhookPublicBaseUrl: () => string | null;
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  recordTelegramStopSubscription: ReturnType<typeof createTelegramMaintenance>["recordTelegramStopSubscription"];
  stageTelegramMaintenance: ReturnType<typeof createTelegramMaintenance>["stageTelegramMaintenance"];
  processTelegramMaintenance: ReturnType<typeof createTelegramMaintenance>["processTelegramMaintenance"];
};
export function createTelegramSetup(db: Db, options: TelegramSetupOptions) {
  const { fetchImpl, getWebhookPublicBaseUrl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS, runtimeContextForRecord, recordTelegramStopSubscription, stageTelegramMaintenance, processTelegramMaintenance } = options;

  async function registerTelegramWebhook(endpoint: EndpointRow, input: ConfigureChatEndpointInput, credentials: Record<string, string>, credentialLease: CredentialMutationLeaseGuard, next: EndpointRecord) {
        const webhookUrl = `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/telegram`;
        const infoResponse = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/getWebhookInfo`,
          { signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS) },
        );
        const infoResult = (await infoResponse.json()) as {
          ok?: boolean;
          description?: string;
          result?: { url?: string };
        };
        if (!infoResponse.ok || !infoResult.ok) {
          throw unprocessable(
            `Telegram could not inspect the existing webhook: ${infoResult.description ?? infoResponse.status}`,
          );
        }
        await credentialLease.assertOwned();
        const response = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/setWebhook`,
          {
            method: "POST",
            signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: credentials.webhookSecret,
              allowed_updates: [
                "message",
                "edited_message",
                "callback_query",
                "stopped_message_generation",
                "message_reaction",
                "my_chat_member",
              ],
              // A first-time connection may inherit stale updates from a bot
              // that was used before Paperclip owned it. Reconnect is
              // different: Telegram may be holding legitimate updates while
              // the old callback URL is unavailable. Preserve that backlog
              // even when an operator is rotating the public origin.
              drop_pending_updates: input.action === "configure",
            }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          description?: string;
          result?: unknown;
        };
        if (!response.ok || !result.ok)
          throw unprocessable(
            `Telegram could not register the webhook: ${result.description ?? response.status}`,
          );
        await credentialLease.assertOwned();
        if (result.ok === true && result.result === true) {
          // Telegram's successful boolean receipt acknowledges the exact URL,
          // secret and allowed_updates request above. GET alone cannot prove
          // secret_token, which Telegram deliberately does not return.
          await recordTelegramStopSubscription(
            next.endpoint,
            runtimeContextForRecord(next),
            credentialLease,
          );
        }
        // Command discovery is optional for ingress, but its provider mutation
        // is still a durable, auditable action. A transient or rate-limited
        // failure is retried by the maintenance worker without blocking the
        // otherwise-valid webhook connection.
        const commandAction = await stageTelegramMaintenance(
          endpoint,
          "register_commands",
        );
        if (commandAction)
          await processTelegramMaintenance(
            commandAction.id,
            false,
            credentialLease,
          );
      }

  return { registerTelegramWebhook };
}
