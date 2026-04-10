import type { Agent, FeedbackVote } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { InlineEntityOption } from "../components/InlineEntitySelector";
import type { MentionOption } from "../components/MarkdownEditor";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";

function createAgent(
  id: string,
  name: string,
  icon: string,
  urlKey: string,
): Agent {
  const now = new Date("2026-04-06T12:00:00.000Z");
  return {
    id,
    companyId: "company-ux",
    name,
    urlKey,
    role: "engineer",
    title: null,
    icon,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
  };
}

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  return {
    id: "comment-default",
    companyId: "company-ux",
    issueId: "issue-ux",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

const primaryAgent = createAgent("agent-1", "CodexCoder", "code", "codexcoder");
const reviewAgent = createAgent("agent-2", "ClaudeFixer", "sparkles", "claudefixer");

export const issueChatUxAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewAgent.id, reviewAgent],
]);

export const issueChatUxMentions: MentionOption[] = [
  {
    id: "mention-agent-1",
    name: primaryAgent.name,
    kind: "agent",
    agentId: primaryAgent.id,
    agentIcon: primaryAgent.icon,
  },
  {
    id: "mention-agent-2",
    name: reviewAgent.name,
    kind: "agent",
    agentId: reviewAgent.id,
    agentIcon: reviewAgent.icon,
  },
  {
    id: "mention-project-1",
    name: "Paperclip Board UI",
    kind: "project",
    projectId: "project-1",
    projectColor: "#0f766e",
  },
];

export const issueChatUxReassignOptions: InlineEntityOption[] = [
  {
    id: `agent:${primaryAgent.id}`,
    label: primaryAgent.name,
    searchText: `${primaryAgent.name} codex engineer`,
  },
  {
    id: `agent:${reviewAgent.id}`,
    label: reviewAgent.name,
    searchText: `${reviewAgent.name} claude reviewer`,
  },
  {
    id: "user:user-1",
    label: "Board",
    searchText: "board user",
  },
];

export const issueChatUxLiveComments: IssueChatComment[] = [
  createComment({
    id: "comment-live-user",
    body: "Ship the issue page as a real chat. Keep the activity feed, but make the assistant flow feel conversational.",
    createdAt: new Date("2026-04-06T11:55:00.000Z"),
    updatedAt: new Date("2026-04-06T11:55:00.000Z"),
  }),
  createComment({
    id: "comment-live-agent",
    authorAgentId: primaryAgent.id,
    authorUserId: null,
    body: "I swapped the old comment stack for the new assistant-ui thread and kept the existing issue mutations intact.",
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    runId: "run-history-1",
    runAgentId: primaryAgent.id,
  }),
  createComment({
    id: "comment-live-queued",
    body: "Can you also make a dedicated review page that shows every chat state side by side?",
    createdAt: new Date("2026-04-06T12:05:30.000Z"),
    updatedAt: new Date("2026-04-06T12:05:30.000Z"),
    clientId: "client-queued-1",
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: "run-live-1",
  }),
];

export const issueChatUxLiveEvents: IssueTimelineEvent[] = [
  {
    id: "event-live-1",
    createdAt: new Date("2026-04-06T11:54:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    statusChange: {
      from: "done",
      to: "todo",
    },
  },
  {
    id: "event-live-2",
    createdAt: new Date("2026-04-06T11:54:30.000Z"),
    actorType: "user",
    actorId: "user-1",
    assigneeChange: {
      from: { agentId: null, userId: null },
      to: { agentId: primaryAgent.id, userId: null },
    },
  },
];

export const issueChatUxLiveRuns: LiveRunForIssue[] = [
  {
    id: "run-live-1",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: "2026-04-06T12:04:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-06T12:04:00.000Z",
    agentId: primaryAgent.id,
    agentName: primaryAgent.name,
    adapterType: "codex_local",
    issueId: "issue-ux",
  },
];

export const issueChatUxLinkedRuns: IssueChatLinkedRun[] = [
  {
    runId: "run-history-1",
    status: "succeeded",
    agentId: primaryAgent.id,
    createdAt: new Date("2026-04-06T11:58:00.000Z"),
    startedAt: new Date("2026-04-06T11:58:00.000Z"),
    finishedAt: new Date("2026-04-06T12:00:00.000Z"),
  },
  {
    runId: "run-review-1",
    status: "failed",
    agentId: reviewAgent.id,
    createdAt: new Date("2026-04-06T12:31:00.000Z"),
    startedAt: new Date("2026-04-06T12:31:00.000Z"),
    finishedAt: new Date("2026-04-06T12:33:00.000Z"),
  },
];

export const issueChatUxTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>([
  [
    "run-history-1",
    [
      {
        kind: "thinking",
        ts: "2026-04-06T11:58:03.000Z",
        text: "Reviewing the issue thread to see where transcript noise still leaks into the conversation.",
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T11:58:07.000Z",
        name: "read_file",
        toolUseId: "tool-history-1",
        input: { path: "ui/src/lib/issue-chat-messages.ts" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T11:58:11.000Z",
        toolUseId: "tool-history-1",
        content: "Found the run projection path that decides whether transcript output survives after completion.",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-04-06T11:59:24.000Z",
        text: "Kept the completed run context attached to the chat timeline so the reasoning can stay folded instead of disappearing.",
      },
    ],
  ],
  [
    "run-live-1",
    [
      {
        kind: "assistant",
        ts: "2026-04-06T12:04:02.000Z",
        text: "I am reshaping the issue page so the thread reads like a conversation instead of a run log.",
      },
      {
        kind: "thinking",
        ts: "2026-04-06T12:04:05.000Z",
        text: "Need to remove the internal scrollbox first, otherwise the page still feels like a nested console.",
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:04:08.000Z",
        name: "read_file",
        toolUseId: "tool-read-1",
        input: { path: "ui/src/components/IssueChatThread.tsx" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:04:11.000Z",
        toolUseId: "tool-read-1",
        content: "Loaded the current chat surface and found the max-h viewport constraint.",
        isError: false,
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:04:14.000Z",
        name: "apply_patch",
        toolUseId: "tool-edit-1",
        input: { file: "ui/src/components/IssueChatThread.tsx", action: "remove scroll pane" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:04:22.000Z",
        toolUseId: "tool-edit-1",
        content: "Updated layout classes and swapped Jump to latest to page-level scrolling.",
        isError: false,
      },
      {
        kind: "stderr",
        ts: "2026-04-06T12:04:24.000Z",
        text: "vite warm-up: rebuilding route chunks",
      },
    ],
  ],
]);

export const issueChatUxSubmittingComments: IssueChatComment[] = [
  createComment({
    id: "comment-submitting-user-settled",
    body: "Let me know once the thread layout is locked down.",
    createdAt: new Date("2026-04-06T12:40:00.000Z"),
    updatedAt: new Date("2026-04-06T12:40:00.000Z"),
  }),
  createComment({
    id: "comment-submitting-pending",
    body: "Looks good — go ahead and ship it when you're ready.",
    createdAt: new Date("2026-04-06T12:42:00.000Z"),
    updatedAt: new Date("2026-04-06T12:42:00.000Z"),
    clientId: "client-pending-1",
    clientStatus: "pending",
  }),
];

export const issueChatUxReviewComments: IssueChatComment[] = [
  createComment({
    id: "comment-review-user",
    body: "This looks close. Tighten the spacing and keep the composer grounded to the chat surface.",
    createdAt: new Date("2026-04-06T12:28:00.000Z"),
    updatedAt: new Date("2026-04-06T12:28:00.000Z"),
  }),
  createComment({
    id: "comment-review-agent",
    authorAgentId: reviewAgent.id,
    authorUserId: null,
    body: [
      "Adjusted the treatment to feel more like a product conversation.",
      "",
      "- Removed the count from the heading",
      "- Let the page own scrolling",
      "- Added a dedicated `/tests/ux/chat` review page",
    ].join("\n"),
    createdAt: new Date("2026-04-06T12:34:00.000Z"),
    updatedAt: new Date("2026-04-06T12:34:00.000Z"),
    runId: "run-review-1",
    runAgentId: reviewAgent.id,
  }),
  createComment({
    id: "comment-review-user-followup",
    body: "Perfect. I also want to see an empty state and a blocked composer state before we merge.",
    createdAt: new Date("2026-04-06T12:36:00.000Z"),
    updatedAt: new Date("2026-04-06T12:36:00.000Z"),
  }),
];

export const issueChatUxReviewEvents: IssueTimelineEvent[] = [
  {
    id: "event-review-1",
    createdAt: new Date("2026-04-06T12:27:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    assigneeChange: {
      from: { agentId: primaryAgent.id, userId: null },
      to: { agentId: reviewAgent.id, userId: null },
    },
  },
];

export const issueChatUxFeedbackVotes: FeedbackVote[] = [
  {
    id: "feedback-1",
    companyId: "company-ux",
    issueId: "issue-ux",
    targetType: "issue_comment",
    targetId: "comment-review-agent",
    authorUserId: "user-1",
    vote: "up",
    reason: null,
    sharedWithLabs: false,
    sharedAt: null,
    consentVersion: null,
    redactionSummary: null,
    createdAt: new Date("2026-04-06T12:35:00.000Z"),
    updatedAt: new Date("2026-04-06T12:35:00.000Z"),
  },
];
