import type { TopicBindingStore } from "./state.js";

export interface CommentSink {
  addComment(args: {
    issueId: string;
    body: string;
    authorLabel: string;
    authorUserId: string | null;
  }): Promise<void>;
}

export interface TelegramUserLinkStore {
  resolve(telegramUserId: number): Promise<{ paperclipUserId: string } | null>;
}

export interface InboundDeps {
  topics: TopicBindingStore;
  comments: CommentSink;
  users: TelegramUserLinkStore;
}

export interface TelegramUpdateMessage {
  chat: { id: number };
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
}

export class InboundHandler {
  constructor(private readonly deps: InboundDeps) {}

  async handle(msg: TelegramUpdateMessage): Promise<void> {
    if (!msg.is_topic_message || msg.message_thread_id == null) return;
    const body = msg.text ?? msg.caption;
    if (!body) return;

    const topic = await this.deps.topics.getByThread(msg.chat.id, msg.message_thread_id);
    if (!topic) return;

    const from = msg.from;
    const link = from ? await this.deps.users.resolve(from.id) : null;
    const authorLabel = link
      ? `@paperclip:${link.paperclipUserId}`
      : from?.username
        ? `[telegram:@${from.username}]`
        : `[telegram:${from?.first_name ?? "unknown"}]`;

    await this.deps.comments.addComment({
      issueId: topic.issueId,
      body,
      authorLabel,
      authorUserId: link?.paperclipUserId ?? null,
    });
  }
}
