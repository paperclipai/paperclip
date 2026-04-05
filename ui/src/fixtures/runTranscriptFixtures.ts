import type { TranscriptEntry } from "../adapters";

export interface RunTranscriptFixtureMeta {
  sourceRunId: string;
  fixtureLabel: string;
  agentName: string;
  agentId: string;
  issueIdentifier: string;
  issueTitle: string;
  startedAt: string;
  finishedAt: string | null;
}

export const runTranscriptFixtureMeta: RunTranscriptFixtureMeta = {
  sourceRunId: "65a79d5d-5f85-4392-a5cc-8fb48beb9e71",
  fixtureLabel: "Sanitized development fixture",
  agentName: "CodexCoder",
  agentId: "codexcoder-fixture",
  issueIdentifier: "PAP-473",
  issueTitle: "Humanize run transcripts across run detail and live surfaces",
  startedAt: "2026-03-11T15:21:05.948Z",
  finishedAt: null,
};

// Sanitized from a real development run. Paths, secrets, env vars, and user-local identifiers
// are replaced with safe placeholders while preserving the interaction shape.
export const runTranscriptFixtureEntries: TranscriptEntry[] = [
  {
    kind: "stderr",
    ts: "2026-03-11T15:21:05.594Z",
    text: "[paperclip] Skipping saved session resume for task \"PAP-473\" because wake reason is issue_assigned.",
  },
  {
    kind: "init",
    ts: "2026-03-11T15:21:05.948Z",
    model: "codex",
    sessionId: "sess_fixture_01",
  },
  {
    kind: "system",
    ts: "2026-03-11T15:21:07.249Z",
    text: "turn started",
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:21:18.851Z",
    text: "I’m starting with the Paperclip heartbeat procedure and the repo-required docs so I can see what task is actually assigned and then work only on that scope.",
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:21:19.026Z",
    name: "command_execution",
    toolUseId: "item_1",
    input: {
      command: "sed -n '1,220p' doc/GOAL.md",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:21:19.026Z",
    name: "command_execution",
    toolUseId: "item_2",
    input: {
      command: "sed -n '1,320p' doc/SPEC-implementation.md",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:21:19.034Z",
    toolUseId: "item_1",
    content: "command: sed -n '1,220p' doc/GOAL.md\nstatus: completed\nexit_code: 0\n\n# Paperclip\n\nPaperclip is the backbone of the autonomous economy.",
    isError: false,
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:21:19.035Z",
    toolUseId: "item_2",
    content: "command: sed -n '1,320p' doc/SPEC-implementation.md\nstatus: completed\nexit_code: 0\n\n# Paperclip V1 Implementation Spec\n\nPaperclip V1 must provide a full control-plane loop for autonomous agents.",
    isError: false,
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:22:08.806Z",
    text: "I’ve got the rendering entry points. I’m reading the existing transcript parser and the three UI surfaces together so I can collapse them onto one renderer instead of layering another one-off view.",
  },
  {
    kind: "thinking",
    ts: "2026-03-11T15:22:12.044Z",
    text: "The current transcript UX duplicates parsing logic in multiple surfaces. A shared presentation layer will make the detail page and live surfaces behave the same way while keeping raw fallback available.",
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:22:15.401Z",
    name: "command_execution",
    toolUseId: "item_3",
    input: {
      command: "rg -n \"LiveRunWidget|ActiveAgentsPanel|buildTranscript|TranscriptEntry|transcript\" ui/src server/src packages",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:22:15.982Z",
    toolUseId: "item_3",
    content: "command: rg -n ...\nstatus: completed\nexit_code: 0\n\nui/src/components/ActiveAgentsPanel.tsx\nui/src/components/LiveRunWidget.tsx\nui/src/pages/AgentDetail.tsx",
    isError: false,
  },
  {
    kind: "system",
    ts: "2026-03-11T15:22:21.617Z",
    text: "item started: web_search (id=ws_fixture_reasoning_ui)",
  },
  {
    kind: "system",
    ts: "2026-03-11T15:22:24.806Z",
    text: "item completed: web_search (id=ws_fixture_reasoning_ui)",
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:22:29.214Z",
    text: "I’ve confirmed the duplication: the run page has the only full transcript renderer, while live surfaces still collapse output into feed strings. I’m pulling markdown utilities and adapter shapes now so the new renderer can stay shared.",
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:23:04.251Z",
    name: "command_execution",
    toolUseId: "item_4",
    input: {
      command: "pnpm -r typecheck",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:23:26.903Z",
    toolUseId: "item_4",
    content: "command: pnpm -r typecheck\nstatus: completed\nexit_code: 0\n\npackages/adapter-utils typecheck: Done\nserver typecheck: Done\nui typecheck: Done\ncli typecheck: Done",
    isError: false,
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:23:34.102Z",
    text: "Typecheck is clean. I’m running the remaining repo checks now so the transcript work is verified under the full workspace build, not just the UI package.",
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:23:40.511Z",
    name: "command_execution",
    toolUseId: "item_5",
    input: {
      command: "pnpm test:run",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:23:56.944Z",
    toolUseId: "item_5",
    content: "command: pnpm test:run\nstatus: failed\nexit_code: 1\n\nFAIL packages/db/src/runtime-config.test.ts\nFAIL src/__tests__/worktree.test.ts\n\nAll transcript-adapter tests passed after snapshot updates.",
    isError: true,
  },
  {
    kind: "thinking",
    ts: "2026-03-11T15:24:02.188Z",
    text: "The remaining failures are unrelated to transcript rendering, so I should isolate them in the handoff and keep the UI change set focused.",
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:24:08.490Z",
    text: "The new parser metadata changed a few adapter test snapshots exactly where expected, and the remaining red tests are outside this change set. I’m keeping the transcript patch focused and shipping with that caveat called out.",
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:24:21.327Z",
    name: "command_execution",
    toolUseId: "item_6",
    input: {
      command: "pnpm build",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:24:44.030Z",
    toolUseId: "item_6",
    content: "command: pnpm build\nstatus: completed\nexit_code: 0\n\nui build: built successfully\ncli build: Done",
    isError: false,
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:24:52.504Z",
    name: "command_execution",
    toolUseId: "item_7",
    input: {
      command: "git commit -m \"Humanize run transcripts across run detail and live surfaces\"",
      cwd: "/workspace/paperclip",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:24:53.104Z",
    toolUseId: "item_7",
    content: "command: git commit ...\nstatus: completed\nexit_code: 0\n\n87b8e21 Humanize run transcripts across run detail and live surfaces",
    isError: false,
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:25:00.908Z",
    text: "Implemented the transcript UI refactor and switched the run detail page, issue live widget, and dashboard agent card onto the same rendering language.",
  },
  {
    kind: "result",
    ts: "2026-03-11T15:25:05.440Z",
    text: "Transcript rollout complete with shared nice/raw rendering and compact live variants.",
    inputTokens: 11240,
    outputTokens: 3460,
    cachedTokens: 520,
    costUsd: 0.048121,
    subtype: "success",
    isError: false,
    errors: [],
  },
];

