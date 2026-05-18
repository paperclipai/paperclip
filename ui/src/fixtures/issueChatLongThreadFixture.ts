import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";

export const LONG_THREAD_COMMENT_COUNT = 469;
export const LONG_THREAD_MARKDOWN_COMMENT_COUNT = 150;
export const LONG_THREAD_EVENT_COUNT = 12;
export const LONG_THREAD_LINKED_RUN_COUNT = 6;

const baseTime = new Date("2026-04-28T14:00:00.000Z").getTime();

function atMinute(offset: number) {
  return new Date(baseTime + offset * 60_000);
}

function createAgent(id: string, name: string, icon: string, urlKey: string): Agent {
  const now = new Date("2026-04-28T14:00:00.000Z");
  return {
    id,
    companyId: "company-long-thread",
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

const primaryAgent = createAgent("agent-perf-codex", "CodexCoder", "code", "codexcoder");
const reviewerAgent = createAgent("agent-perf-reviewer", "ReviewBot", "sparkles", "reviewbot");

export const issueChatLongThreadAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewerAgent.id, reviewerAgent],
]);

function markdownBody(index: number) {
  return [
    `## Baseline note ${index}`,
    "",
    `This assistant update captures a deterministic markdown-heavy row for long-thread rendering. It references [PAP-${2600 + index}](/PAP/issues/PAP-${2600 + index}) and includes enough structure to exercise markdown parsing.`,
    "",
    "- Parsed checklist item one with inline `code`",
    "- Parsed checklist item two with **bold** and _italic_ text",
    "- Parsed checklist item three with a link to [Paperclip](/PAP/dashboard)",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Fixture row | ${index} |`,
    `| Synthetic tokens | ${1200 + index} |`,
    "",
    "```ts",
    `const fixtureRow${index} = { markdown: true, deterministic: true };`,
    "```",
  ].join("\n");
}

function plainUserBody(index: number) {
  return `Board checkpoint ${index}: keep the issue-detail page responsive while the thread is full of historical comments.`;
}

function plainAssistantBody(index: number) {
  return `Processed checkpoint ${index}. The current direct-render path should keep this row mounted with the rest of the thread.`;
}

function createComment(index: number): IssueChatComment {
  const isMarkdown = index < LONG_THREAD_MARKDOWN_COMMENT_COUNT;
  const isAssistant = isMarkdown || index % 4 === 1 || index % 4 === 2;
  const authorAgentId = isAssistant
    ? (index % 7 === 0 ? reviewerAgent.id : primaryAgent.id)
    : null;

  return {
    id: `long-thread-comment-${String(index + 1).padStart(3, "0")}`,
    companyId: "company-long-thread",
    issueId: "issue-long-thread",
    authorType: authorAgentId ? "agent" : "user",
    authorAgentId,
    authorUserId: authorAgentId ? null : "user-board",
    body: isMarkdown
      ? markdownBody(index + 1)
      : authorAgentId
        ? plainAssistantBody(index + 1)
        : plainUserBody(index + 1),
    presentation: null,
    metadata: null,
    createdAt: atMinute(index),
    updatedAt: atMinute(index),
  };
}

export const issueChatLongThreadComments: IssueChatComment[] = Array.from(
  { length: LONG_THREAD_COMMENT_COUNT },
  (_, index) => createComment(index),
);

export const issueChatLongThreadMarkdownCommentIds = new Set(
  issueChatLongThreadComments
    .slice(0, LONG_THREAD_MARKDOWN_COMMENT_COUNT)
    .map((comment) => comment.id),
);

export const issueChatLongThreadEvents: IssueTimelineEvent[] = Array.from(
  { length: LONG_THREAD_EVENT_COUNT },
  (_, index) => ({
    id: `long-thread-event-${index + 1}`,
    createdAt: atMinute(index * 36 + 18),
    actorType: index % 3 === 0 ? "user" : "agent",
    actorId: index % 3 === 0 ? "user-board" : primaryAgent.id,
    statusChange: index % 2 === 0
      ? { from: index === 0 ? "todo" : "in_progress", to: "in_progress" }
      : undefined,
    assigneeChange: index % 2 === 1
      ? {
          from: { agentId: null, userId: null },
          to: { agentId: index % 4 === 1 ? primaryAgent.id : reviewerAgent.id, userId: null },
        }
      : undefined,
  }),
);

export const issueChatLongThreadLinkedRuns: IssueChatLinkedRun[] = Array.from(
  { length: LONG_THREAD_LINKED_RUN_COUNT },
  (_, index) => ({
    runId: `long-thread-run-${index + 1}`,
    status: index % 3 === 0 ? "failed" : index % 3 === 1 ? "timed_out" : "succeeded",
    agentId: index % 2 === 0 ? primaryAgent.id : reviewerAgent.id,
    agentName: index % 2 === 0 ? primaryAgent.name : reviewerAgent.name,
    adapterType: "codex_local",
    createdAt: atMinute(index * 72 + 12),
    startedAt: atMinute(index * 72 + 12),
    finishedAt: atMinute(index * 72 + 16),
    hasStoredOutput: true,
  }),
);

export const issueChatLongThreadLiveRuns: LiveRunForIssue[] = [];

export const issueChatLongThreadTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>(
  issueChatLongThreadLinkedRuns.map((run, index) => [
    run.runId,
    [
      {
        kind: "thinking",
        ts: atMinute(index * 72 + 13).toISOString(),
        text: `Inspecting long-thread segment ${index + 1}.`,
      },
      {
        kind: "tool_call",
        ts: atMinute(index * 72 + 14).toISOString(),
        name: "read_file",
        toolUseId: `long-thread-tool-${index + 1}`,
        input: { path: "ui/src/components/IssueChatThread.tsx" },
      },
      {
        kind: "tool_result",
        ts: atMinute(index * 72 + 15).toISOString(),
        toolUseId: `long-thread-tool-${index + 1}`,
        content: "Confirmed the direct-render fixture keeps the full message subtree mounted.",
        isError: run.status !== "succeeded",
      },
      {
        kind: "assistant",
        ts: atMinute(index * 72 + 16).toISOString(),
        text: `Run ${index + 1} produced a compact transcript row for adjacent run context.`,
      },
    ],
  ]),
);

export const issueChatLongThreadFixtureContext = {
  issue: {
    identifier: "PAP-PERF",
    title: "Long-thread rendering baseline fixture",
    status: "in_progress",
    priority: "medium",
    projectName: "Paperclip App",
  },
  documents: [
    "Implementation Plan",
    "Profiler Notes",
    "Release Checklist",
    "QA Readout",
  ],
  subIssues: [
    "Phase 1: Add long-thread perf fixture and baseline",
    "Phase 2: Isolate issue-thread row rendering and Markdown work",
    "Phase 3: Apply virtualization and guard scroll behavior",
    "Phase 4: Verify production issue profile improvement",
  ],
  sidebarStats: [
    ["Comments", String(LONG_THREAD_COMMENT_COUNT)],
    ["Markdown bodies", String(LONG_THREAD_MARKDOWN_COMMENT_COUNT)],
    ["Timeline events", String(LONG_THREAD_EVENT_COUNT)],
    ["Linked runs", String(LONG_THREAD_LINKED_RUN_COUNT)],
  ],
} as const;
