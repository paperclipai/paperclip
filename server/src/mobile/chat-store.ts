export type MobileChatRole = "user" | "assistant";
export type MobileChatStatus = "sent" | "failed";

export interface MobileChatMessage {
  id: string;
  role: MobileChatRole;
  text: string;
  status: MobileChatStatus;
  createdAt: string;
  replyToId: string | null;
  error: string | null;
}

export interface MobileChatStore {
  list(): MobileChatMessage[];
  createUserMessage(text: string): MobileChatMessage;
  createAssistantMessage(text: string, replyToId: string): MobileChatMessage;
  markFailed(id: string, reason: string): MobileChatMessage;
  retry(id: string): MobileChatMessage;
}

export interface MobileChatStoreOptions {
  now?: () => Date;
}

export const createMobileChatStore = (
  opts: MobileChatStoreOptions = {},
): MobileChatStore => {
  const now = opts.now ?? (() => new Date());
  const messages: MobileChatMessage[] = [];
  let nextId = 1;

  const findMessage = (id: string): MobileChatMessage => {
    for (const message of messages) {
      if (message.id === id) {
        return message;
      }
    }

    throw new Error(`Mobile chat message not found: ${id}`);
  };

  const createMessage = (
    role: MobileChatRole,
    text: string,
    replyToId: string | null,
  ): MobileChatMessage => {
    const message: MobileChatMessage = {
      id: `mobile-chat-${nextId}`,
      role,
      text,
      status: "sent",
      createdAt: now().toISOString(),
      replyToId,
      error: null,
    };

    nextId += 1;
    messages.push(message);

    return message;
  };

  return {
    list: () => messages.map((message) => ({ ...message })),
    createUserMessage: (text) => createMessage("user", text, null),
    createAssistantMessage: (text, replyToId) =>
      createMessage("assistant", text, replyToId),
    markFailed: (id, reason) => {
      const message = findMessage(id);
      message.status = "failed";
      message.error = reason;

      return message;
    },
    retry: (id) => {
      const message = findMessage(id);
      message.status = "sent";
      message.error = null;

      return message;
    },
  };
};
