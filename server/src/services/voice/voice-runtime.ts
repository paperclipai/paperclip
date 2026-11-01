import { ThreadImpl, type Adapter, type Thread } from "chat";
import type { ChatProvider } from "@paperclipai/shared";
import type { ChatSdkEndpointRuntime } from "../chat-sdk-runtime.js";
import { createPaperclipChatSdkState, type ChatSdkStatePersistence } from "../chat-sdk-state.js";

/** Shared control-plane port. Provider SDK classes and voice implement it separately. */
export type ChatEndpointRuntime = Omit<ChatSdkEndpointRuntime, "provider" | "sdkAdapterKey"> & { readonly provider: ChatProvider; readonly sdkAdapterKey: string };
export interface CreateVoiceRuntimeOptions { companyId: string; endpointId: string; userName: string; persistence: ChatSdkStatePersistence }

/**
 * Voice uses signed session tools and a pull outbox, not a Chat SDK adapter's
 * webhook/message transport. ThreadImpl is only the existing work queue's
 * thread/state facade; all external publication goes through the voice outbox.
 */
export function createVoiceRuntime(options: CreateVoiceRuntimeOptions): ChatEndpointRuntime {
  let retired = false;
  const assertActive = () => { if (retired) throw new Error("Voice runtime is retired"); };
  const unsupported = (): never => { throw new Error("This operation is not supported by the voice transport"); };
  const adapter: Adapter<string> = {
    name: "speko", userName: options.userName,
    channelIdFromThreadId: (id) => id, decodeThreadId: (id) => id, encodeThreadId: (id) => id,
    addReaction: unsupported, removeReaction: unsupported, deleteMessage: unsupported, editMessage: unsupported,
    parseMessage: unsupported, renderFormatted: unsupported, postMessage: unsupported,
    handleWebhook: unsupported, initialize: async () => { assertActive(); },
    fetchThread: async (id) => { assertActive(); return { id, channelId: id, isDM: true, metadata: {} }; },
    fetchChannelInfo: async (id) => { assertActive(); return { id, name: "Voice conversation", isDM: true, metadata: {} }; },
    fetchMessages: async () => { assertActive(); return { messages: [] }; },
    startTyping: async () => { assertActive(); },
  };
  const state = createPaperclipChatSdkState({ ...options });
  const thread = (id: string): Thread => {
    assertActive();
    if (!/^speko:[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid voice conversation identity");
    return new ThreadImpl({ adapter, stateAdapter: state, id, channelId: id, isDM: true });
  };
  return {
    companyId: options.companyId, endpointId: options.endpointId, provider: "speko", sdkAdapterKey: "speko",
    initialize: async () => { assertActive(); }, shutdown: async () => { retired = true; },
    thread, channel: (id) => thread(id).channel, getProviderAdapter: () => adapter,
    getUser: async () => null, openDirectMessage: unsupported, abortTurn: async () => { assertActive(); },
    handleWebhook: unsupported, streamTelegramDraft: unsupported, postSlackFilePublication: unsupported,
    resolveSlackFileUploadReceipt: unsupported, recordMicrosoftTeamsRoute: unsupported,
    sendTeamsFileConsentCard: unsupported, sendTeamsUploadedFileCard: unsupported, ensureDiscordRootThread: unsupported,
    parseTelegramCommandMessage: () => null, parseMicrosoftTeamsMessage: () => null,
    acceptsProviderScope: () => false, attachmentRecoveryDescriptor: () => null, rehydrateAttachment: () => null,
    applyGitHubReceiptReaction: unsupported, applySlackReceiptReaction: unsupported, sendTelegramCallbackNotice: unsupported,
    fetchTeamsInlineImage: unsupported, resolveGitHubAttachmentComment: unsupported,
  };
}
