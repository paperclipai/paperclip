import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  buildAssistantPartsFromTranscript,
  buildIssueChatMessages,
  stabilizeThreadMessages,
  type IssueChatComment,
  type IssueChatLinkedRun,
} from "./issue-chat-messages";
import type {
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "./issue-thread-interactions";
import type { IssueTimelineEvent } from "./issue-timeline-events";
import type { LiveRunForIssue } from "../api/heartbeats";

function createAgent(id: string, name: string): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    role: "engineer",
    title: null,
    icon: "code",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    pauseReason: null,
    pausedAt: null,
    urlKey: "codexcoder",
    permissions: { canCreateAgents: false },
  } as Agent;
}

function createComment(overrides: Partial<IssueChatComment> = {}): IssueChatComment {
  const authorAgentId = overrides.authorAgentId ?? null;
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Hello",
    authorType: authorAgentId ? "agent" : "user",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createInteraction(
  overrides: Partial<SuggestTasksInteraction> = {},
): SuggestTasksInteraction {
  return {
    id: "interaction-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "suggest_tasks",
    title: "Suggested follow-up work",
    summary: "Preview the next issue tree before accepting it.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:02:00.000Z"),
    updatedAt: new Date("2026-04-06T12:02:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      tasks: [
        {
          clientKey: "task-1",
          title: "Prototype the card",
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function createRequestConfirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "confirmation-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: "Review and approve the latest plan.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Approve the plan?",
    },
    result: null,
    ...overrides,
  };
}

describe("buildAssistantPartsFromTranscript", () => {
  it("maps assistant text, reasoning, and tool activity while omitting noisy stderr", () => {
    const result = buildAssistantPartsFromTranscript([
      { kind: "assistant", ts: "2026-04-06T12:00:00.000Z", text: "Working on it. " },
      { kind: "assistant", ts: "2026-04-06T12:00:01.000Z", text: "Done." },
      { kind: "thinking", ts: "2026-04-06T12:00:02.000Z", text: "Need to inspect files." },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:00:03.000Z",
        name: "read_file",
        toolUseId: "tool-1",
        input: { path: "ui/src/pages/IssueDetail.tsx" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:00:04.000Z",
        toolUseId: "tool-1",
        content: "file contents",
        isError: false,
      },
      { kind: "stderr", ts: "2026-04-06T12:00:05.000Z", text: "warn: noisy setup output" },
    ]);

    expect(result.parts).toHaveLength(3);
    expect(result.parts[0]).toMatchObject({ type: "text", text: "Working on it. Done." });
    expect(result.parts[1]).toMatchObject({ type: "reasoning", text: "Need to inspect files." });
    expect(result.parts[2]).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "read_file",
      result: "file contents",
      isError: false,
    });
    expect(result.notices).toEqual([]);
  });

  it("preserves transcript ordering when text and tool activity are interleaved", () => {
    const result = buildAssistantPartsFromTranscript([
      { kind: "assistant", ts: "2026-04-06T12:00:00.000Z", text: "First." },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:00:01.000Z",
        name: "read_file",
        toolUseId: "tool-1",
        input: { path: "ui/src/components/IssueChatThread.tsx" },
      },
      { kind: "assistant", ts: "2026-04-06T12:00:02.000Z", text: "Second." },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:00:03.000Z",
        toolUseId: "tool-1",
        content: "ok",
        isError: false,
      },
      { kind: "thinking", ts: "2026-04-06T12:00:04.000Z", text: "Need one more check." },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:00:05.000Z",
        name: "write_file",
        toolUseId: "tool-2",
        input: { path: "ui/src/lib/issue-chat-messages.ts" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:00:06.000Z",
        toolUseId: "tool-2",
        content: "saved",
        isError: false,
      },
    ]);

    expect(result.parts).toMatchObject([
      { type: "text", text: "First." },
      { type: "tool-call", toolCallId: "tool-1", toolName: "read_file", result: "ok" },
      { type: "text", text: "Second." },
      { type: "reasoning", text: "Need one more check." },
      { type: "tool-call", toolCallId: "tool-2", toolName: "write_file", result: "saved" },
    ]);
  });

  it("treats a completed tool-only segment as resolved once a tool_result arrives", () => {
    const result = buildAssistantPartsFromTranscript([
      { kind: "thinking", ts: "2026-04-06T12:00:00.000Z", text: "Checking the task." },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:00:01.000Z",
        name: "search",
        toolUseId: "tool-1",
        input: { query: "paperclip" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:00:02.000Z",
        toolUseId: "tool-1",
        content: "search completed",
        isError: false,
      },
      { kind: "assistant", ts: "2026-04-06T12:00:03.000Z", text: "Found the relevant code." },
    ]);

    expect(result.parts).toMatchObject([
      { type: "reasoning", text: "Checking the task." },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "search",
        result: "search completed",
        isError: false,
      },
      { type: "text", text: "Found the relevant code." },
    ]);
    expect(result.segments).toEqual([{
      startMs: new Date("2026-04-06T12:00:00.000Z").getTime(),
      endMs: new Date("2026-04-06T12:00:02.000Z").getTime(),
    }]);
  });

  it("keeps run errors while suppressing init and system transcript noise", () => {
    const result = buildAssistantPartsFromTranscript([
      {
        kind: "init",
        ts: "2026-04-06T12:00:00.000Z",
        model: "gpt-5.4",
        sessionId: "session-123",
      },
      {
        kind: "system",
        ts: "2026-04-06T12:00:01.000Z",
        text: "item started: planning_step (id=step-1)",
      },
      {
        kind: "system",
        ts: "2026-04-06T12:00:02.000Z",
        text: "item completed: planning_step (id=step-1)",
      },
      {
        kind: "result",
        ts: "2026-04-06T12:00:03.000Z",
        text: "Tool crashed during execution",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "error",
        isError: true,
        errors: ["ENOENT: missing file"],
      },
    ]);

    expect(result.parts).toMatchObject([
      {
        type: "reasoning",
        text: "Run error: ENOENT: missing file",
      },
    ]);
    expect(result.notices).toEqual([]);
  });

  it("preserves diff transcript output as a fenced diff block", () => {
    const result = buildAssistantPartsFromTranscript([
      { kind: "assistant", ts: "2026-04-06T12:00:00.000Z", text: "Applied the patch." },
      { kind: "diff", ts: "2026-04-06T12:00:01.000Z", changeType: "file_header", text: "ui/src/lib/issue-chat-messages.ts" },
      { kind: "diff", ts: "2026-04-06T12:00:02.000Z", changeType: "add", text: "+function formatDiffBlock(lines: string[]) {" },
      { kind: "diff", ts: "2026-04-06T12:00:03.000Z", changeType: "add", text: "+  return ````diff`;" },
    ]);

    expect(result.parts).toMatchObject([
      { type: "text", text: "Applied the patch." },
      {
        type: "text",
        text: [
          "```diff",
          "ui/src/lib/issue-chat-messages.ts",
          "+function formatDiffBlock(lines: string[]) {",
          "+  return ````diff`;",
          "```",
        ].join("\n"),
      },
    ]);
  });
});

describe("buildIssueChatMessages", () => {
  it("uses the company user label for current-user comments instead of collapsing to You", () => {
    const messages = buildIssueChatMessages({
      comments: [createComment({ authorUserId: "user-1" })],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
      userLabelMap: new Map([["user-1", "Dotta"]]),
    });

    expect(messages[0]).toMatchObject({
      role: "user",
      metadata: {
        custom: {
          authorName: "Dotta",
          authorUserId: "user-1",
        },
      },
    });
  });

  it("prefers derived agent attribution when a board-authored comment is proven to come from a run", () => {
    const agentMap = new Map<string, Agent>([["agent-1", createAgent("agent-1", "Claude")]]);
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          authorUserId: "user-1",
          derivedAuthorAgentId: "agent-1",
          derivedCreatedByRunId: "run-1",
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      agentMap,
      currentUserId: "user-1",
      userLabelMap: new Map([["user-1", "Dotta"]]),
    });

    expect(messages[0]).toMatchObject({
      role: "assistant",
      metadata: {
        custom: {
          authorName: "Claude",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: "user-1",
          runId: "run-1",
          runAgentId: "agent-1",
        },
      },
    });
  });

  it("renders a comment as agent-authored when runAgentId is set from activity log", () => {
    const agentMap = new Map<string, Agent>([["agent-1", createAgent("agent-1", "Claude")]]);
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          authorUserId: "user-1",
          runId: "run-1",
          runAgentId: "agent-1",
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      agentMap,
      currentUserId: "user-1",
      userLabelMap: new Map([["user-1", "Dotta"]]),
    });

    expect(messages[0]).toMatchObject({
      role: "assistant",
      metadata: {
        custom: {
          authorName: "Claude",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: "user-1",
          runId: "run-1",
          runAgentId: "agent-1",
        },
      },
    });
  });

  it("orders events before comments and appends active live runs as running assistant messages", () => {
    const agentMap = new Map<string, Agent>([["agent-1", createAgent("agent-1", "CodexCoder")]]);
    const comments = [
      createComment(),
      createComment({
        id: "comment-2",
        authorAgentId: "agent-1",
        authorUserId: null,
        body: "I made the change.",
        createdAt: new Date("2026-04-06T12:03:00.000Z"),
        updatedAt: new Date("2026-04-06T12:03:00.000Z"),
        runId: "run-1",
        runAgentId: "agent-1",
      }),
    ];
    const timelineEvents: IssueTimelineEvent[] = [
      {
        id: "event-1",
        createdAt: new Date("2026-04-06T11:59:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        statusChange: {
          from: "done",
          to: "todo",
        },
      },
    ];
    const linkedRuns: IssueChatLinkedRun[] = [
      {
        runId: "run-history-1",
        status: "succeeded",
        agentId: "agent-1",
        createdAt: new Date("2026-04-06T12:01:00.000Z"),
        startedAt: new Date("2026-04-06T12:01:00.000Z"),
        finishedAt: new Date("2026-04-06T12:02:00.000Z"),
      },
    ];
    const liveRuns: LiveRunForIssue[] = [
      {
        id: "run-live-1",
        status: "running",
        invocationSource: "manual",
        triggerDetail: null,
        startedAt: "2026-04-06T12:04:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-06T12:04:00.000Z",
        agentId: "agent-1",
        agentName: "CodexCoder",
        adapterType: "codex_local",
      },
    ];

    const messages = buildIssueChatMessages({
      comments,
      timelineEvents,
      linkedRuns,
      liveRuns,
      transcriptsByRunId: new Map([
        [
          "run-live-1",
          [{ kind: "assistant", ts: "2026-04-06T12:04:01.000Z", text: "Streaming reply" }],
        ],
      ]),
      hasOutputForRun: (runId) => runId === "run-live-1",
      companyId: "company-1",
      projectId: "project-1",
      agentMap,
      currentUserId: "user-1",
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "system:activity:event-1",
      "user:comment-1",
      "assistant:comment-2",
      "assistant:run-assistant:run-live-1",
    ]);

    const liveRunMessage = messages.at(-1);
    expect(liveRunMessage).toMatchObject({
      role: "assistant",
      status: { type: "running" },
    });
    expect(liveRunMessage?.content[0]).toMatchObject({
      type: "text",
      text: "Streaming reply",
    });
  });

  it("merges thread interactions into the same chronological feed as comments and runs", () => {
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          id: "comment-1",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          updatedAt: new Date("2026-04-06T12:01:00.000Z"),
        }),
      ],
      interactions: [
        createInteraction({
          id: "interaction-2",
          createdAt: new Date("2026-04-06T12:02:00.000Z"),
          updatedAt: new Date("2026-04-06T12:02:00.000Z"),
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [
        {
          id: "run-live-1",
          status: "running",
          invocationSource: "manual",
          triggerDetail: null,
          startedAt: "2026-04-06T12:03:00.000Z",
          finishedAt: null,
          createdAt: "2026-04-06T12:03:00.000Z",
          agentId: "agent-1",
          agentName: "CodexCoder",
          adapterType: "codex_local",
        },
      ],
      transcriptsByRunId: new Map([
        [
          "run-live-1",
          [{ kind: "assistant", ts: "2026-04-06T12:03:01.000Z", text: "Working on it." }],
        ],
      ]),
      hasOutputForRun: (runId) => runId === "run-live-1",
      currentUserId: "user-1",
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:comment-1",
      "system:interaction:interaction-2",
      "assistant:run-assistant:run-live-1",
    ]);
    expect(messages[1]).toMatchObject({
      metadata: {
        custom: {
          kind: "interaction",
          anchorId: "interaction-interaction-2",
        },
      },
    });
  });

  it("places request confirmations after later same-run handoff status and comment", () => {
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          id: "comment-handoff",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Ready for approval.",
          createdAt: new Date("2026-04-06T12:03:00.000Z"),
          updatedAt: new Date("2026-04-06T12:03:00.000Z"),
          runId: "run-1",
          runAgentId: "agent-1",
        }),
        createComment({
          id: "comment-user-reply",
          body: "Approved.",
          createdAt: new Date("2026-04-06T12:04:00.000Z"),
          updatedAt: new Date("2026-04-06T12:04:00.000Z"),
        }),
      ],
      interactions: [
        createRequestConfirmation({
          id: "confirmation-1",
          sourceRunId: "run-1",
          status: "expired",
          result: {
            version: 1,
            outcome: "superseded_by_comment",
            commentId: "comment-user-reply",
          },
        }),
      ],
      timelineEvents: [
        {
          id: "event-in-review",
          actorType: "agent",
          actorId: "agent-1",
          createdAt: new Date("2026-04-06T12:02:00.000Z"),
          runId: "run-1",
          statusChange: {
            from: "in_progress",
            to: "in_review",
          },
        },
      ],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "system:activity:event-in-review",
      "assistant:comment-handoff",
      "system:interaction:confirmation-1",
      "user:comment-user-reply",
    ]);
  });

  it("keeps request confirmations chronological without later same-run handoff evidence", () => {
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          id: "comment-later",
          createdAt: new Date("2026-04-06T12:02:00.000Z"),
          updatedAt: new Date("2026-04-06T12:02:00.000Z"),
        }),
      ],
      interactions: [
        createRequestConfirmation({
          id: "confirmation-1",
          sourceRunId: "run-1",
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "system:interaction:confirmation-1",
      "user:comment-later",
    ]);
  });

  it("does not move request confirmations past unrelated comments before same-run handoff", () => {
    const messages = buildIssueChatMessages({
      comments: [
        createComment({
          id: "comment-user-reply",
          body: "I have a question first.",
          createdAt: new Date("2026-04-06T12:02:00.000Z"),
          updatedAt: new Date("2026-04-06T12:02:00.000Z"),
        }),
        createComment({
          id: "comment-handoff",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Ready for approval.",
          createdAt: new Date("2026-04-06T12:03:00.000Z"),
          updatedAt: new Date("2026-04-06T12:03:00.000Z"),
          runId: "run-1",
          runAgentId: "agent-1",
        }),
      ],
      interactions: [
        createRequestConfirmation({
          id: "confirmation-1",
          sourceRunId: "run-1",
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
      "system:interaction:confirmation-1",
      "user:comment-user-reply",
      "assistant:comment-handoff",
    ]);
  });

  it("keeps succeeded runs as assistant messages when transcript output exists", () => {
    const agentMap = new Map<string, Agent>([["agent-1", createAgent("agent-1", "CodexCoder")]]);
    const messages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [
        {
          runId: "run-history-1",
          status: "succeeded",
          agentId: "agent-1",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          startedAt: new Date("2026-04-06T12:01:00.000Z"),
          finishedAt: new Date("2026-04-06T12:03:00.000Z"),
        },
      ],
      liveRuns: [],
      transcriptsByRunId: new Map([
        [
          "run-history-1",
          [
            { kind: "thinking", ts: "2026-04-06T12:01:10.000Z", text: "Checking the current issue thread." },
            { kind: "assistant", ts: "2026-04-06T12:02:30.000Z", text: "Updated the thread renderer." },
          ],
        ],
      ]),
      hasOutputForRun: (runId) => runId === "run-history-1",
      agentMap,
      currentUserId: "user-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "run-assistant:run-history-1",
      role: "assistant",
      status: { type: "complete", reason: "stop" },
      metadata: {
        custom: {
          kind: "historical-run",
          runId: "run-history-1",
          chainOfThoughtLabel: "Worked for 2 minutes",
        },
      },
    });
    expect(messages[0]?.content).toMatchObject([
      { type: "reasoning", text: "Checking the current issue thread." },
      { type: "text", text: "Updated the thread renderer." },
    ]);
  });

  it("compacts long run transcripts in issue chat while preserving matching tool context", () => {
    const isoAt = (baseMs: number, offsetSeconds: number) =>
      new Date(baseMs + offsetSeconds * 1000).toISOString();
    const baseMs = Date.parse("2026-04-06T12:00:00.000Z");
    const transcript = [
      ...Array.from({ length: 9 }, (_, index) => ({
        kind: "assistant" as const,
        ts: isoAt(baseMs, index),
        text: `Older update ${index + 1}`,
      })),
      {
        kind: "tool_call" as const,
        ts: isoAt(baseMs, 9),
        name: "search",
        toolUseId: "tool-keep",
        input: { query: "issue chat virtualization" },
      },
      ...Array.from({ length: 79 }, (_, index) => ({
        kind: "assistant" as const,
        ts: isoAt(baseMs, 10 + index),
        text: `Recent update ${index + 1}`,
      })),
      {
        kind: "tool_result" as const,
        ts: isoAt(baseMs, 89),
        toolUseId: "tool-keep",
        content: "search completed",
        isError: false,
      },
    ];

    const messages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [
        {
          runId: "run-history-3",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "CodexCoder",
          createdAt: new Date("2026-04-06T12:00:00.000Z"),
          startedAt: new Date("2026-04-06T12:00:00.000Z"),
          finishedAt: new Date("2026-04-06T12:03:00.000Z"),
        },
      ],
      liveRuns: [],
      transcriptsByRunId: new Map([["run-history-3", transcript]]),
      hasOutputForRun: (runId) => runId === "run-history-3",
      currentUserId: "user-1",
    });

    expect(messages).toHaveLength(1);
    const textParts = messages[0]?.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text) ?? [];
    expect(textParts.join("\n")).not.toContain("Older update 1");
    expect(messages[0]?.content).toContainEqual(expect.objectContaining({
      type: "tool-call",
      toolCallId: "tool-keep",
      toolName: "search",
      result: "search completed",
    }));
  });

  it("keeps the same assistant message id when a live run becomes a cancelled historical run", () => {
    const liveMessages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [
        {
          id: "run-1",
          status: "running",
          invocationSource: "manual",
          triggerDetail: null,
          startedAt: "2026-04-06T12:01:00.000Z",
          finishedAt: null,
          createdAt: "2026-04-06T12:01:00.000Z",
          agentId: "agent-1",
          agentName: "CodexCoder",
          adapterType: "codex_local",
        },
      ],
      transcriptsByRunId: new Map([
        ["run-1", [{ kind: "assistant", ts: "2026-04-06T12:01:05.000Z", text: "Working on it." }]],
      ]),
      hasOutputForRun: (runId) => runId === "run-1",
      currentUserId: "user-1",
    });

    const cancelledMessages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [
        {
          runId: "run-1",
          status: "cancelled",
          agentId: "agent-1",
          agentName: "CodexCoder",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          startedAt: new Date("2026-04-06T12:01:00.000Z"),
          finishedAt: new Date("2026-04-06T12:01:08.000Z"),
        },
      ],
      liveRuns: [],
      transcriptsByRunId: new Map([
        ["run-1", [{ kind: "assistant", ts: "2026-04-06T12:01:05.000Z", text: "Working on it." }]],
      ]),
      hasOutputForRun: (runId) => runId === "run-1",
      currentUserId: "user-1",
    });

    expect(liveMessages).toHaveLength(1);
    expect(cancelledMessages).toHaveLength(1);
    expect(liveMessages[0]).toMatchObject({ id: "run-assistant:run-1", status: { type: "running" } });
    expect(cancelledMessages[0]).toMatchObject({
      id: "run-assistant:run-1",
      status: { type: "complete", reason: "stop" },
      metadata: { custom: { runStatus: "cancelled" } },
    });
  });

  it("labels pause-caused cancelled runs as paused by board", () => {
    const messages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [
        {
          runId: "run-paused",
          status: "cancelled",
          agentId: "agent-1",
          agentName: "CodexCoder",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          startedAt: new Date("2026-04-06T12:01:00.000Z"),
          finishedAt: new Date("2026-04-06T12:02:00.000Z"),
          resultJson: { stopReason: "paused" },
        },
      ],
      liveRuns: [],
      transcriptsByRunId: new Map([
        ["run-paused", [{ kind: "assistant", ts: "2026-04-06T12:01:05.000Z", text: "Working on it." }]],
      ]),
      hasOutputForRun: (runId) => runId === "run-paused",
      currentUserId: "user-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadata.custom).toMatchObject({
      chainOfThoughtLabel: "Paused by board after 1 minute",
      runStatus: "cancelled",
    });
  });

  it("can keep succeeded runs without transcript output for embedded run feeds", () => {
    const messages = buildIssueChatMessages({
      comments: [],
      timelineEvents: [],
      linkedRuns: [
        {
          runId: "run-history-2",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "CodexCoder",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          startedAt: new Date("2026-04-06T12:01:00.000Z"),
          finishedAt: new Date("2026-04-06T12:03:00.000Z"),
        },
      ],
      liveRuns: [],
      includeSucceededRunsWithoutOutput: true,
      currentUserId: "user-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "run:run-history-2",
      role: "system",
      metadata: {
        custom: {
          kind: "run",
          runId: "run-history-2",
          runAgentName: "CodexCoder",
          runStatus: "succeeded",
        },
      },
    });
  });
});

describe("stabilizeThreadMessages", () => {
  it("reuses unchanged message objects across rebuilds", () => {
    const firstPass = buildIssueChatMessages({
      comments: [createComment()],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    const firstStable = stabilizeThreadMessages(firstPass, [], new Map());
    const secondPass = buildIssueChatMessages({
      comments: [
        createComment(),
        createComment({
          id: "comment-2",
          body: "New message",
          createdAt: new Date("2026-04-06T12:01:00.000Z"),
          updatedAt: new Date("2026-04-06T12:01:00.000Z"),
        }),
      ],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    const secondStable = stabilizeThreadMessages(
      secondPass,
      firstStable.messages,
      firstStable.cache,
    );

    expect(secondStable.messages).toHaveLength(2);
    expect(secondStable.messages[0]).toBe(firstStable.messages[0]);
    expect(secondStable.messages[1]?.id).toBe("comment-2");
  });

  it("reuses the previous array when nothing semantically changed", () => {
    const firstPass = buildIssueChatMessages({
      comments: [createComment()],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    const firstStable = stabilizeThreadMessages(firstPass, [], new Map());
    const secondPass = buildIssueChatMessages({
      comments: [createComment()],
      timelineEvents: [],
      linkedRuns: [],
      liveRuns: [],
      currentUserId: "user-1",
    });

    const secondStable = stabilizeThreadMessages(
      secondPass,
      firstStable.messages,
      firstStable.cache,
    );

    expect(secondStable.messages).toBe(firstStable.messages);
  });
});
