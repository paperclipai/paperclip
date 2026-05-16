import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "@/lib/issue-chat-messages";

export const issueChatRendererCrashRunId = "run-issue-chat-renderer-crash";
export const issueChatRendererCrashSentinel = "ISSUE_CHAT_RENDERER_CRASH_SENTINEL";

export const issueChatRendererCrashComments: IssueChatComment[] = [
  {
    id: "comment-renderer-crash-request",
    companyId: "company-storybook",
    issueId: "issue-chat-renderer-crash",
    authorAgentId: null,
    authorUserId: "user-board",
    body: "Captured repro shape: a long issue thread with mixed tool-use output should not collapse the whole chat if one rich message row fails.",
    createdAt: new Date("2026-05-05T05:30:00.000Z"),
    updatedAt: new Date("2026-05-05T05:30:00.000Z"),
  },
  {
    id: "comment-renderer-crash-followup",
    companyId: "company-storybook",
    issueId: "issue-chat-renderer-crash",
    authorAgentId: "agent-qa",
    authorUserId: null,
    body: "QA follow-up: messages after the failing row must keep their normal rich rendering.",
    createdAt: new Date("2026-05-05T05:37:00.000Z"),
    updatedAt: new Date("2026-05-05T05:37:00.000Z"),
  },
];

export const issueChatRendererCrashLinkedRuns: IssueChatLinkedRun[] = [
  {
    runId: issueChatRendererCrashRunId,
    status: "succeeded",
    agentId: "agent-codex",
    adapterType: "codex_local",
    agentName: "Codex",
    createdAt: new Date("2026-05-05T05:31:00.000Z"),
    startedAt: new Date("2026-05-05T05:31:05.000Z"),
    finishedAt: new Date("2026-05-05T05:36:40.000Z"),
    hasStoredOutput: true,
    logBytes: 190_000,
    resultJson: {
      stopReason: "stop",
    },
  },
];

export const issueChatRendererCrashTranscript: IssueChatTranscriptEntry[] = [
  {
    kind: "assistant",
    ts: "2026-05-05T05:31:08.000Z",
    text: "I am reading the issue detail renderer and the transcript projection together before editing.",
  },
  {
    kind: "thinking",
    ts: "2026-05-05T05:31:30.000Z",
    text: "Need to keep a narrow fix: do not rewrite the chat architecture, just prevent one bad row from taking down the whole thread.",
  },
  {
    kind: "tool_call",
    ts: "2026-05-05T05:32:02.000Z",
    name: "exec_command",
    toolUseId: "tool-read-renderer",
    input: {
      cmd: "rg -n \"IssueChatThread|MarkdownBody|tool-call\" ui/src/components ui/src/lib",
      workdir: "/Users/kmullaney/keegoid/repos/paperclip-dev-137",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-05-05T05:32:06.000Z",
    toolUseId: "tool-read-renderer",
    toolName: "exec_command",
    content: [
      "ui/src/components/IssueChatThread.tsx:584:const IssueChatTextPart",
      "ui/src/components/IssueChatThread.tsx:1049:function IssueChatToolPart",
      "ui/src/lib/issue-chat-messages.ts:577:export function buildAssistantPartsFromTranscript",
    ].join("\n"),
  },
  {
    kind: "tool_call",
    ts: "2026-05-05T05:33:40.000Z",
    name: "apply_patch",
    toolUseId: "tool-patch-renderer",
    input: {
      file: "ui/src/components/IssueChatThread.tsx",
      action: "add row-level fallback",
      expected: "one failing message row degrades in place",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-05-05T05:33:49.000Z",
    toolUseId: "tool-patch-renderer",
    toolName: "apply_patch",
    content: "Patch applied. The transcript row below carries the regression sentinel used by the component test.",
  },
  {
    kind: "assistant",
    ts: "2026-05-05T05:34:12.000Z",
    text: [
      "Regression payload:",
      "",
      issueChatRendererCrashSentinel,
      "",
      "The renderer should keep later issue comments visible even if this row throws during rich markdown rendering.",
    ].join("\n"),
  },
  {
    kind: "assistant",
    ts: "2026-05-05T05:36:20.000Z",
    text: "The rest of the issue thread remains usable; only the failing row should use the plain text fallback.",
  },
];

export const issueChatRendererCrashTranscriptsByRunId = new Map<
  string,
  readonly IssueChatTranscriptEntry[]
>([
  [issueChatRendererCrashRunId, issueChatRendererCrashTranscript],
]);
