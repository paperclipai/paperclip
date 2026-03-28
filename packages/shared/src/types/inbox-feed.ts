import type { Issue } from "./issue.js";

export interface InboxFeedActivity {
  action: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  actorName: string | null;
  summary: string;
  timestamp: string;
  runId: string | null;
}

export interface InboxFeedItem {
  issue: Issue;
  latestActivity: InboxFeedActivity | null;
  unreadCount: number;
}
