import type { IssueComment } from "@paperclipai/shared";
import { storybookAgents } from "../../fixtures/paperclipData";
import type { CompanyUserProfile } from "@/lib/company-members";

// Representative fixtures. No private task content or tenant identities.
export const alexId = "fixture-alex";
export const samId = "fixture-sam";
export const issueId = "fixture-human-identity-task";
export const profiles = new Map<string, CompanyUserProfile>([
  [alexId, { label: "Alex Morgan", image: null }],
  [samId, { label: "Sam Rivera", image: null }],
]);
export const humanMessages = [
  { id: "comment-1", authorUserId: samId, body: "Can you check the task title?", time: "15:33:00" },
  { id: "comment-2", authorUserId: samId, body: "The notification still shows the previous title.", time: "15:35:14" },
  { id: "comment-3", authorUserId: samId, body: "I updated it from the task page.", time: "15:36:10" },
  { id: "comment-4", authorUserId: alexId, body: "Thanks, I will check the next notification.", time: "15:36:18" },
  { id: "comment-5", authorUserId: samId, body: "Please check the sender avatar too.", time: "15:40:00" },
  { id: "comment-6", authorUserId: samId, body: "I still see the old task title.", time: "15:42:11" },
  { id: "comment-7", authorUserId: alexId, body: "Thanks — I am working on it.", time: "15:42:29" },
];
export const comments: IssueComment[] = humanMessages.map(row => ({
  id: row.id, companyId: "company-paperclip", issueId,
  authorType: "user", authorUserId: row.authorUserId, authorAgentId: null,
  body: row.body, presentation: null, metadata: null,
  createdAt: new Date(`2026-10-09T${row.time}-05:00`),
  updatedAt: new Date(`2026-10-09T${row.time}-05:00`),
}));
export const agentId = "fixture-chat-assistant";
export const assistant = { ...storybookAgents[0]!, id: agentId, name: "Fable" };
export const agentMap = new Map([[agentId, assistant]]);
export const mixedComments: IssueComment[] = [
  {
    ...comments[0]!, id: "comment-review-request", authorUserId: alexId,
    body: "Please review the task title and notification.",
    createdAt: new Date("2026-10-09T12:31:00-05:00"), updatedAt: new Date("2026-10-09T12:31:00-05:00"),
  },
  {
    ...comments[0]!, id: "comment-agent-reply", authorType: "agent", authorUserId: null, authorAgentId: agentId,
    body: "I checked the notification. The sender name and avatar are visible.",
    createdAt: new Date("2026-10-09T12:37:00-05:00"), updatedAt: new Date("2026-10-09T12:37:00-05:00"),
  },
  ...comments,
];
