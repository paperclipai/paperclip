import { vi } from "vitest";
import {
  TypedEventStream,
  type GrpcAdvancedIMessage,
  type Chat,
  type Message,
  type LiveEvent,
  type CatchUpEvent,
} from "@photon-ai/advanced-imessage";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
} from "../../services/chat-sdk-state.js";
import { PhotonState } from "../../services/photon/state.js";
import {
  PhotonCloudClient,
  PhotonLineAuthentication,
} from "../../services/photon/cloud.js";
import {
  PhotonChatAdapter,
  photonThreadId,
} from "../../services/photon/adapter.js";
export function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const key = (scope: { companyId: string; endpointId: string }, key: string) =>
    `${scope.companyId}:${scope.endpointId}:${key}`;
  return {
    async read(scope, id) {
      return structuredClone(rows.get(key(scope, id)) ?? null);
    },
    async compareAndSet(input) {
      const id = key(input, input.key),
        current = rows.get(id);
      if ((current?.version ?? null) !== input.expectedVersion) return false;
      rows.set(id, {
        value: structuredClone(input.value),
        version: (current?.version ?? 0) + 1,
        expiresAt: input.expiresAt,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const id = key(input, input.key);
      if (rows.get(id)?.version !== input.expectedVersion) return false;
      return rows.delete(id);
    },
  };
}
export function stream<T>(values: T[]): TypedEventStream<T> {
  return new TypedEventStream(
    (async function* () {
      for (const value of values) yield value;
    })(),
    async () => {},
  );
}
export function photonChat(
  guid = "iMessage;-;+15555550101",
  isGroup = false,
): Chat {
  return {
    guid,
    service: "iMessage",
    isGroup,
    isArchived: false,
    displayName: isGroup ? "Test group" : "",
    participants: [{ address: "+15555550101", service: "iMessage" }],
    properties: {},
  } as unknown as Chat;
}
export function photonMessage(
  guid: string,
  chatGuid: string,
  text = "Hello",
  fromMe = false,
): Message {
  return {
    guid,
    chatGuids: [chatGuid],
    content: { text, attachments: [], parts: [], mentions: [] },
    sender: { address: "+15555550101", service: "iMessage" },
    dateCreated: new Date(),
    isFromMe: fromMe,
    isSystemMessage: false,
    isServiceMessage: false,
  } as unknown as Message;
}
export function photonEvent(
  sequence: number,
  chat = photonChat(),
  text = "Hello",
): LiveEvent {
  return {
    type: "message.received",
    chatGuid: chat.guid,
    message: photonMessage(`message-${sequence}`, chat.guid, text),
    sequence,
    occurredAt: new Date(),
    isFromMe: false,
  } as LiveEvent;
}
export function photonFixture() {
  const persistence = memoryPersistence();
  const state = new PhotonState(
    { companyId: "company", endpointId: "endpoint" },
    persistence,
  );
  const cloud = new PhotonCloudClient();
  const allocation = vi.spyOn(cloud, "allocation").mockResolvedValue({
    inspection: {
      projectId: "project",
      projectName: "Tests",
      allocation: "dedicated",
      eligible: true,
      lines: [{ lineId: "line", phoneNumber: "+15555550100", eligible: true }],
    },
    tokens: new Map([["line", "private-line-token"]]),
    expiresIn: 300,
  });
  const authentication = new PhotonLineAuthentication(
    { projectId: "project", lineId: "line", phoneNumber: "+15555550100" },
    "private-project-secret",
    cloud,
  );
  const chat = photonChat();
  const receipts = new Map<string, Message>();
  const polls = new Map<
    string,
    {
      pollMessageGuid: string;
      options: { optionIdentifier: string; text: string }[];
    }
  >();
  const events: CatchUpEvent[] = [];
  const sendText = vi.fn(
    async (
      chatGuid: string,
      text: string,
      opts: { clientMessageId: string },
    ) => {
      if (!receipts.has(opts.clientMessageId))
        receipts.set(
          opts.clientMessageId,
          photonMessage(`sent-${receipts.size}`, chatGuid, text, true),
        );
      return receipts.get(opts.clientMessageId)!;
    },
  );
  const client = {
    close: vi.fn(async () => {}),
    chats: {
      get: vi.fn(async () => chat),
      setTyping: vi.fn(async () => {}),
      subscribeEvents: vi.fn(() => stream([])),
    },
    messages: {
      sendText,
      sendAttachment: vi.fn(
        async (
          chatGuid: string,
          attachment: string,
          opts: { clientMessageId: string },
        ) => sendText(chatGuid, attachment, opts),
      ),
      edit: vi.fn(),
      get: vi.fn(async (id) => photonMessage(id, chat.guid)),
      subscribeEvents: vi.fn(() => stream([])),
    },
    attachments: {
      upload: vi.fn(async () => ({ attachment: { guid: "uploaded-file" } })),
      downloadStream: vi.fn(),
    },
    groups: { subscribeEvents: vi.fn(() => stream([])) },
    polls: {
      create: vi.fn(
        async (
          _chat: string,
          _title: string,
          labels: string[],
          opts: { clientMessageId: string },
        ) => {
          if (!polls.has(opts.clientMessageId))
            polls.set(opts.clientMessageId, {
              pollMessageGuid: `poll-${polls.size}`,
              options: labels.map((text, index) => ({
                optionIdentifier: `${polls.size}-option-${index}`,
                text,
              })),
            });
          return polls.get(opts.clientMessageId)!;
        },
      ),
      subscribeEvents: vi.fn(() => stream([])),
    },
    events: { catchUp: vi.fn(() => stream(events)) },
  };
  const adapter = new PhotonChatAdapter(
    "Agent",
    authentication,
    state,
    client as unknown as GrpcAdvancedIMessage,
  );
  const threadId = photonThreadId({
    lineId: "line",
    chatGuid: chat.guid,
    isGroup: false,
  });
  return {
    state,
    persistence,
    allocation,
    cloud,
    authentication,
    chat,
    client,
    adapter,
    threadId,
    receipts,
    events,
    polls,
  };
}
