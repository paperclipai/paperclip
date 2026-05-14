import type { IssueStatus, TopicBinding } from "./types.js";

export interface TopicBindingStore {
  getByIssueId(issueId: string): Promise<TopicBinding | null>;
  getByThread(chatId: number, messageThreadId: number): Promise<TopicBinding | null>;
  upsert(binding: TopicBinding): Promise<void>;
  updateStatusSnapshot(issueId: string, status: IssueStatus): Promise<void>;
}
