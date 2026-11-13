import type { ChatSdkMessageCallbackEvent } from "../../chat-sdk-runtime.js";
import type { EndpointRecord, EndpointRow, InboundRuntimeContext, RuntimeContext } from "../runtime-types.js";
import { notFound } from "../../../errors.js";

type SdkMessageOptions = {
  receiptReactionSupported?: boolean;
  slackSlashControl?: boolean;
};

type SdkMessageReceiverOptions = {
  endpointRecord: (endpointId: string) => Promise<Pick<EndpointRecord, "endpoint"> | null>;
  ingressOnly: (provider: ChatSdkMessageCallbackEvent["provider"]) => boolean;
  processMessage: (...args: [
    endpoint: EndpointRow,
    thread: ChatSdkMessageCallbackEvent["thread"],
    message: ChatSdkMessageCallbackEvent["message"],
    trigger: ChatSdkMessageCallbackEvent["trigger"],
    ingressOnly: boolean,
    recoveredProviderUrl: string | null,
    runtimeContext: InboundRuntimeContext | undefined,
    providerUpdateId: number | undefined,
    admittedDeliveryId: string | null,
    receiptReactionSupported: boolean,
    preauthorizedUserId?: string | null,
    deferDrainUntilFollowup?: boolean,
    suppressSetupDestinationActivation?: boolean,
    slackSlashControl?: boolean,
  ]) => Promise<void>;
};

export function createChatSdkMessageReceiver(options: SdkMessageReceiverOptions) {
  const { endpointRecord, ingressOnly, processMessage } = options;
  async function receiveSdkMessages(
    event: ChatSdkMessageCallbackEvent,
    runtimeContext?: RuntimeContext,
    messageOptions: SdkMessageOptions = {},
  ) {
    const record = await endpointRecord(event.endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const messages = [...(event.context?.skipped ?? []), event.message];
    for (const message of messages)
      await processMessage(
        record.endpoint,
        event.thread,
        message,
        message === event.message ? event.trigger : "subscribed_message",
        ingressOnly(event.provider),
        null,
        runtimeContext,
        event.providerUpdateId,
        null,
        messageOptions.receiptReactionSupported !== false,
        undefined,
        false,
        false,
        messageOptions.slackSlashControl === true,
      );
  }
  return { receiveSdkMessages };
}
