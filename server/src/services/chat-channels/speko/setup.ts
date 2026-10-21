import type { EndpointRow } from "../runtime-types.js";

import { syncSpekoVoiceTools } from "../../voice/speko-agent-tools.js";
import { configureSpekoSessionTools } from "../../voice/speko-tool-setup.js";
import { createSpekoProvider } from "../../voice/speko-provider.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import type { Db } from "@paperclipai/db";

import {
  forbidden,
  unprocessable,
} from "../../../errors.js";

import type { DbTransaction } from "../runtime-types.js";
type SpekoSetupOptions = {
  fetchImpl: typeof globalThis.fetch;
  getWebhookPublicBaseUrl: () => string | null;
  allowLocalVoiceBoard?: boolean;
};
export function createSpekoSetup(db: Db, options: SpekoSetupOptions) {
  const { fetchImpl, getWebhookPublicBaseUrl } = options;

  async function installSpekoVoiceTools(tx: DbTransaction, endpoint: EndpointRow, actorUserId?: string | null) {
          if (!actorUserId) throw forbidden("An authenticated connection owner is required to install phone tools");
          await syncSpekoVoiceTools(tx, endpoint, actorUserId, true, options.allowLocalVoiceBoard === true);
        }

  async function configureSpekoTools(endpoint: EndpointRow, credentials: Record<string, string>, credentialLease: CredentialMutationLeaseGuard, previousSpekoSigningSecret: string | undefined) {
        const webhookPublicBaseUrl = getWebhookPublicBaseUrl();
        if (!webhookPublicBaseUrl?.startsWith("https://")) throw unprocessable("Speko needs an explicitly configured public HTTPS callback origin");
        await configureSpekoSessionTools(db, { companyId: endpoint.companyId, endpointId: endpoint.id, agentId: credentials.agentId, callbackUrl: `${webhookPublicBaseUrl}/api/voice-webhooks/${endpoint.publicId}/tools`, signingSecret: credentials.signingSecret, previousSigningSecret: previousSpekoSigningSecret, client: createSpekoProvider(credentials.apiKey, fetchImpl), assertOwned: () => credentialLease.assertOwned() });
      }

  return { installSpekoVoiceTools, configureSpekoTools };
}
