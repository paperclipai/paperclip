import type { Db } from "@paperclipai/db";
import { conflict, HttpError, notFound } from "../../../errors.js";
import { voiceSessionService } from "../../voice/voice-session-service.js";
import { voiceSessionStore, currentVoiceCredentialFingerprint } from "../../voice/voice-session-store.js";
import { createSpekoProvider } from "../../voice/speko-provider.js";
import type { ChatRuntime } from "../../chat-runtime.js";
import type { ChatSdkRuntime } from "../../chat-sdk-runtime.js";
import type { ChatSdkStatePersistence } from "../../chat-sdk-state.js";
import type { createChatCredentials } from "../credentials.js";
import type { EndpointRow, EndpointRecord } from "../runtime-types.js";

type SpekoChannelOptions = Pick<Parameters<typeof voiceSessionService>[1], "allowLocalBoard" | "onQuestionAnswered"> & {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  resolveCredentialRefs: ReturnType<typeof createChatCredentials>["resolveCredentialRefs"];
  fetchImpl: typeof globalThis.fetch;
};
export function createSpekoChannelService(db: Db, options: SpekoChannelOptions) {
  const { endpointRecord, resolveCredentialRefs, fetchImpl } = options;
  return voiceSessionService(db, {
    allowLocalBoard: options.allowLocalBoard,
    credentials: async (endpoint, expectedFingerprint) => {
      const record = await endpointRecord(endpoint.id);
      if (!record || record.endpoint.companyId !== endpoint.companyId) throw notFound("Voice connection not found");
      if (expectedFingerprint && await currentVoiceCredentialFingerprint(db, endpoint.companyId, record.credentialSecretRefs) !== expectedFingerprint) throw conflict("Voice credentials changed during setup");
      return resolveCredentialRefs(endpoint, record.credentialSecretRefs);
    },
    provider: (apiKey) => createSpekoProvider(apiKey, fetchImpl),
    onQuestionAnswered: options.onQuestionAnswered,
  });
}

export async function authorizeSpekoPublicVoiceTask(db: Db, endpoint: EndpointRow, externalId: string, authorizePrincipal: ReturnType<typeof voiceSessionStore>["authorizePrincipal"]): Promise<boolean> {
        try {
          const authority = await db.transaction(tx => authorizePrincipal(tx, endpoint.companyId, endpoint.id, externalId));
          return authority.allowed && authority.userId === null;
        } catch (error) {
          if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error;
        }
  return false;
}

export function replaceSpekoChannelRuntime(runtime: ChatRuntime | ChatSdkRuntime, record: EndpointRecord, persistence: ChatSdkStatePersistence) {
  if (!("replaceVoiceEndpoint" in runtime)) throw conflict("Voice runtime is unavailable");
  return runtime.replaceVoiceEndpoint({ companyId: record.endpoint.companyId, endpointId: record.endpoint.id, userName: record.assignedAgentName, persistence });
}

export const SPEKO_CONVERSATION_IS_LINEAR = false;
