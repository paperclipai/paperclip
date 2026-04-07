import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  buildAssistantPartsFromTranscript,
  buildIssueChatMessages,
  type IssueChatComment,
  type IssueChatLinkedRun,
} from "./issue-chat-messages";
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
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Hello",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
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
      "assistant:live-run:run-live-1",
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
      id: "historical-run:run-history-1",
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
});
