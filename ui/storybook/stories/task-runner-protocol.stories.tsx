import { useState, type ComponentProps, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueDocument } from "@paperclipai/shared";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import {
  TaskChatTurnStatusIsland,
  taskChatTurnStatusModel,
} from "@/components/task-chat/TaskChatTurnStatusIsland";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import type {
  TaskChatItem,
  TaskChatProviderActivityFamily,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "@/components/task-chat/task-chat-model";
import { runtimeRequestReplacesComposerSkip } from "@/components/task-chat/task-chat-model";
import {
  answeredAskUserQuestionsInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSuggestedTasksInteraction,
  issueThreadInteractionFixtureMeta,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const TS = "2026-08-21T12:00:00.000Z";
const boardUserLabels = new Map([
  [issueThreadInteractionFixtureMeta.currentUserId, "Riley Board"],
]);

function prp(
  eventType: string,
  payload: Record<string, unknown>,
  itemId?: string,
): string {
  return JSON.stringify({
    type: "paperclip.prp.event",
    event: { eventType, itemId, payload },
  });
}

function protocolItems(events: string[], running = false): TaskChatItem[] {
  const parser = paperclipRunnerUIAdapter.createStdoutParser!();
  const transcript = events.flatMap((event, index) =>
    parser.parseLine(
      event,
      new Date(Date.parse(TS) + index * 1000).toISOString(),
    ),
  );
  return transcriptToTaskChatItems(transcript, {
    runId: "storybook-run",
    agentName: "Codex",
    running,
  });
}

const providerEvents = [
  prp("plan.updated", {
    planId: "plan-1",
    revision: 3,
    complete: false,
    syncStatus: "not_applicable",
    documentRevision: null,
    explanation: "Implement the production protocol surfaces.",
    steps: [
      { stepId: "one", body: "Inventory protocol events", status: "completed" },
      {
        stepId: "two",
        body: "Render task-page widgets",
        status: "in_progress",
      },
      { stepId: "three", body: "Verify Storybook coverage", status: "pending" },
    ],
  }),
  prp("tool.execution.completed", {
    executionId: "exec-1",
    transport: "process",
    operation: "execute",
    name: "pnpm test",
    target: "ui",
    status: "completed",
    durationMs: 8420,
    exitCode: 0,
    output: "63 tests passed",
    outputBytes: 15,
    outputTruncated: false,
  }),
  prp("research.completed", {
    researchId: "research-1",
    action: "search",
    status: "completed",
    query: "Paperclip protocol UX",
    sources: [
      {
        sourceId: "source-1",
        title: "Protocol design notes",
        url: "https://example.com/protocol",
        snippet: "Provider-neutral interaction guidance.",
      },
    ],
  }),
  prp("delegation.updated", {
    delegationId: "delegation-1",
    action: "spawn",
    status: "running",
    children: [
      {
        childId: "child-1",
        role: "UI reviewer",
        model: "gpt-5",
        status: "completed",
        summary: "Reviewed interaction states.",
        activitySummary: "4 files",
      },
      {
        childId: "child-2",
        role: "Test author",
        model: "gpt-5",
        status: "running",
        summary: null,
        activitySummary: "Writing contract tests",
      },
    ],
  }),
  prp("model.route.changed", {
    routeId: "route-1",
    provider: "openai",
    requestedModel: "auto",
    fromModel: null,
    effectiveModel: "gpt-5",
    reason: "Task complexity",
  }),
  prp("context.compacted", {
    compactionId: "compact-1",
    reason: "context_window",
    preTokens: 112000,
    postTokens: 48000,
    sameSession: true,
  }),
  prp("artifact.generated", {
    artifactId: "artifact-1",
    status: "completed",
    reference: "artifacts/protocol-report.md",
    mediaType: "text/markdown",
    registered: true,
    transparentBackground: null,
    failure: null,
  }),
  prp("review.mode.changed", {
    reviewId: "review-1",
    state: "entered",
    scope: "task changes",
  }),
  prp("hook.completed", {
    hookId: "hook-1",
    event: "post-test",
    scope: "workspace",
    status: "completed",
    blocking: false,
    durationMs: 320,
    summary: "Checks recorded",
  }),
  prp("memory.citation.referenced", {
    citationId: "citation-1",
    messageItemId: "message-1",
    label: "Prior task decision",
    available: true,
    reference: "document:architecture",
  }),
  prp("safety.review.completed", {
    reviewId: "safety-1",
    targetExecutionId: "exec-1",
    status: "completed",
    decision: "allowed",
    summary: "No destructive operation detected",
  }),
  prp("terminal.input.sent", {
    executionId: "exec-1",
    origin: "agent",
    inputClass: "control",
    byteCount: 1,
  }),
  prp("wait.started", {
    waitId: "wait-1",
    reason: "provider_backoff",
    status: "running",
    plannedDurationMs: 2000,
    elapsedDurationMs: 500,
  }),
  prp("provider.notice.recorded", {
    noticeId: "notice-1",
    level: "warning",
    code: "rate_limit",
    message: "Provider throughput is temporarily reduced.",
    action: "The runner will retry automatically.",
  }),
];

const workspaceEvents = [
  prp("workspace.change.updated", {
    changeSetId: "changes-1",
    revision: 1,
    source: "harness_reported",
    complete: false,
    files: [
      {
        path: "ui/src/App.tsx",
        operation: "modify",
        previousPath: null,
        additions: 2,
        deletions: 1,
        binary: false,
        diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line",
      },
    ],
    totals: { files: 1, additions: 2, deletions: 1 },
    patchArtifactRef: null,
  }),
  prp("workspace.diff.recorded", {
    changeSetId: "changes-1",
    revision: 2,
    source: "runner_verified",
    complete: true,
    files: [
      {
        path: "ui/src/App.tsx",
        operation: "modify",
        previousPath: null,
        additions: 2,
        deletions: 1,
        binary: false,
        diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line",
      },
      {
        path: "ui/src/new-card.tsx",
        operation: "create",
        previousPath: null,
        additions: 14,
        deletions: 0,
        binary: false,
        diff: "@@ -0,0 +1,2 @@\n+export function Card() {\n+  return null;\n+}",
      },
      {
        path: "ui/public/preview.png",
        operation: "modify",
        previousPath: null,
        additions: null,
        deletions: null,
        binary: true,
        diff: null,
      },
      {
        path: "ui/src/old.ts",
        operation: "rename",
        previousPath: "ui/src/legacy.ts",
        additions: 0,
        deletions: 0,
        binary: false,
        diff: null,
      },
    ],
    totals: { files: 4, additions: 16, deletions: 1 },
    patchArtifactRef: "artifact:patch-1",
  }),
];

const dot220Files = [
  ["README.md", 9],
  ["package.json", 1],
  ["public/game.js", 17],
  ["public/index.html", 2],
  ["public/style.css", 1],
  ["server.js", 6],
  ["test/server.test.js", 5],
].map(([path, additions]) => ({
  path: String(path),
  operation: "create",
  previousPath: null,
  additions: Number(additions),
  deletions: 0,
  binary: false,
  diff: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${additions} @@\n+DOT-220 generated ${path}`,
}));

const dot220WorkspaceEvents = [
  prp("workspace.change.updated", {
    changeSetId: "01a03964-9fa6-7550-a87e-b6acc72e372a:workspace",
    revision: 1,
    source: "harness_reported",
    complete: false,
    files: dot220Files.slice(0, 2),
    totals: { files: 2, additions: 10, deletions: 0 },
    patchArtifactRef: null,
  }),
  prp("workspace.change.updated", {
    changeSetId: "01a03964-9fa6-7550-a87e-b6acc72e372a:workspace",
    revision: 2,
    source: "harness_reported",
    complete: false,
    files: dot220Files.slice(0, 5),
    totals: { files: 5, additions: 30, deletions: 0 },
    patchArtifactRef: null,
  }),
  prp("workspace.diff.recorded", {
    changeSetId: "01a03964-9fa6-7550-a87e-b6acc72e372a:workspace",
    revision: 3,
    source: "runner_verified",
    complete: true,
    files: dot220Files,
    totals: { files: 7, additions: 41, deletions: 0 },
    patchArtifactRef: null,
  }),
];

const manyWorkspaceFiles = [
  ...dot220Files,
  {
    path: "packages/a-very-long-workspace-package-name/src/components/nested/WorkspaceChangeDetailsPanel.tsx",
    operation: "rename",
    previousPath: "packages/ui/src/LegacyWorkspacePanel.tsx",
    additions: 0,
    deletions: 0,
    binary: false,
    diff: "similarity index 100%\nrename from packages/ui/src/LegacyWorkspacePanel.tsx\nrename to packages/a-very-long-workspace-package-name/src/components/nested/WorkspaceChangeDetailsPanel.tsx\n",
  },
  {
    path: "ui/public/deleted-preview.svg",
    operation: "delete",
    previousPath: null,
    additions: 0,
    deletions: 3,
    binary: false,
    diff: "diff --git a/ui/public/deleted-preview.svg b/ui/public/deleted-preview.svg\n--- a/ui/public/deleted-preview.svg\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-<svg>\n-  <path />\n-</svg>\n",
  },
  {
    path: "ui/public/workspace-preview.png",
    operation: "modify",
    previousPath: null,
    additions: null,
    deletions: null,
    binary: true,
    diff: null,
  },
];

function workspaceStateEvent(
  changeSetId: string,
  files: typeof manyWorkspaceFiles,
  overrides: Record<string, unknown> = {},
) {
  const known = files.every(
    (file) => file.additions != null && file.deletions != null,
  );
  return prp("workspace.diff.recorded", {
    changeSetId,
    revision: 1,
    source: "runner_verified",
    complete: true,
    files,
    totals: {
      files: files.length,
      additions: known
        ? files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
        : null,
      deletions: known
        ? files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
        : null,
    },
    patchArtifactRef: null,
    ...overrides,
  });
}

const fileReferenceEvent = prp("workspace.file.referenced", {
  referenceId: "reference-1",
  source: "runner_verified",
  path: "packages/paperclip-runner/protocol/README.md",
  displayName: "README.md",
  mediaType: "text/markdown",
  presentation: "document",
  line: 42,
  preview:
    "# Paperclip Runner Protocol\n\nThe runner emits provider-neutral events that the task page renders as durable operator-facing widgets.",
  previewTruncated: false,
  contentDigest: null,
});

const resultEvents = [
  prp("runtime_request.created", {
    request: {
      requestId: "request-1",
      requestKind: "command_approval",
      turnId: "turn-1",
      type: "item/commandExecution/requestApproval",
      status: "pending",
      prompt: "Allow the test command to run?",
      actions: ["accept", "accept_for_session", "decline", "cancel"],
    },
  }),
  prp("run.result.proposed", {
    reportedWorkDisposition: "needs_review",
    summary: "Protocol surfaces are implemented and ready for review.",
    completionClaim: {
      objectiveSatisfied: true,
      remainingWork: [
        { description: "Review the visual snapshots", blocksCompletion: false },
      ],
    },
    verification: [
      {
        commandOrCheck: "pnpm --filter @paperclipai/ui typecheck",
        status: "passed",
        detail: "No errors",
      },
    ],
    artifacts: [
      {
        kind: "work_product",
        ref: "protocol-report",
        title: "Coverage report",
      },
    ],
    attentionRequests: [],
    evidence: [],
  }),
  prp("run.terminal", {
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "needs_review",
  }),
];

const runtimeQuestionReceipts: TaskChatRuntimeRequestItem[] = [
  {
    id: "runtime-question-resolved",
    kind: "protocol",
    surface: "runtime_request",
    runId: "storybook-run",
    requestId: "question-resolved",
    requestKind: "user_input",
    turnId: "turn-1",
    requestType: "input",
    status: "resolved",
    prompt: "Codex requests user input.",
    choices: [],
    fields: [],
    resolvedAction: "submit",
    questionSet: {
      schema: "paperclip.question_set.v1",
      title: "Codex needs your input",
      questions: [
        {
          id: "loop",
          header: "Core loop",
          prompt: "What should the first playable version center on?",
          required: false,
          answerMode: "single_select",
          options: [
            { id: "colony", label: "Colony survival", recommended: true },
          ],
        },
        {
          id: "view",
          header: "Presentation",
          prompt: "Which browser presentation should define the game?",
          required: false,
          answerMode: "single_select",
          options: [{ id: "tiles", label: "2D tile grid", recommended: true }],
        },
      ],
    },
    response: {
      schema: "paperclip.question_response.v1",
      answers: {
        loop: { selectedOptionIds: ["colony"] },
        view: { selectedOptionIds: ["tiles"] },
      },
    },
  },
  {
    id: "runtime-question-cancelled",
    kind: "protocol",
    surface: "runtime_request",
    runId: "storybook-run",
    requestId: "question-cancelled",
    requestKind: "user_input",
    turnId: "turn-1",
    requestType: "input",
    status: "cancelled",
    prompt: "Codex requests user input.",
    choices: [],
    fields: [],
    resolvedAction: "cancel",
    questionSet: {
      schema: "paperclip.question_set.v1",
      title: "Codex needs your input",
      questions: [
        {
          id: "depth",
          header: "MVP depth",
          prompt: "How ambitious should the first milestone be?",
          required: false,
          answerMode: "text",
        },
      ],
    },
  },
];

const pendingRuntimePermission: TaskChatRuntimeRequestItem = {
  id: "runtime-permission-pending",
  kind: "protocol",
  surface: "runtime_request",
  runId: "storybook-run",
  requestId: "permission-pending",
  requestKind: "command_approval",
  turnId: "turn-1",
  requestType: "permission",
  status: "pending",
  prompt: "Allow the test command to run?",
  choices: [
    { key: "accept", label: "Allow once" },
    { key: "accept_for_session", label: "Allow for session" },
    { key: "decline", label: "Deny" },
    { key: "cancel", label: "Cancel" },
  ],
  fields: [],
};

const pendingRuntimeTextInput: TaskChatRuntimeRequestItem = {
  id: "runtime-text-input-pending",
  kind: "protocol",
  surface: "runtime_request",
  runId: "storybook-run",
  requestId: "text-input-pending",
  requestKind: "user_input",
  turnId: "turn-1",
  requestType: "input",
  status: "pending",
  prompt: "Which environment should the verification target?",
  choices: [
    { key: "decline", label: "Deny" },
    { key: "cancel", label: "Cancel" },
  ],
  fields: [
    { name: "environment", label: "Environment", placeholder: "staging" },
  ],
};

function TaskPageFrame({
  children,
  composerDisabledReason,
  takeover,
  pendingTakeover,
  composerAccessory,
}: {
  children: ReactNode;
  composerDisabledReason?: string;
  takeover?: ComponentProps<typeof TaskChatComposer>["takeover"];
  pendingTakeover?: ComponentProps<typeof TaskChatComposer>["pendingTakeover"];
  composerAccessory?: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto flex min-h-(--sz-70vh) w-full max-w-(--tc-shell-max-w) flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {children}
        <div className="flex flex-col gap-2 border-t border-border bg-background/90 p-3">
          {composerAccessory}
          <TaskChatComposer
            onAdd={() => undefined}
            workMode="standard"
            disabled={Boolean(composerDisabledReason)}
            disabledReason={composerDisabledReason}
            draftKey="storybook:runner-protocol"
            takeover={takeover}
            pendingTakeover={pendingTakeover}
          />
        </div>
      </section>
    </main>
  );
}

function TurnStatusStory({
  items,
  mobile = false,
  status = "running",
}: {
  items: TaskChatItem[];
  mobile?: boolean;
  status?: string;
}) {
  const model =
    status === "running" || status === "queued"
      ? taskChatTurnStatusModel(items)
      : null;
  const content = (
    <TaskPageFrame
      composerAccessory={
        model ? <TaskChatTurnStatusIsland model={model} /> : null
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={
          <TaskHeader title="Show live turn progress above the composer" />
        }
        items={[
          {
            id: "request",
            kind: "message",
            author: "human",
            text: "Implement this and keep the turn checklist current.",
          },
        ]}
        tail={
          <TaskChatRunnerTurn
            runId="storybook-run"
            agentName="Codex"
            items={items}
            status={status}
            startedAtMs={Date.now() - 18_000}
            finishedAtMs={
              status === "running" || status === "queued" ? null : Date.now()
            }
          />
        }
      />
    </TaskPageFrame>
  );
  return mobile ? (
    <div className="mx-auto max-w-(--sz-390px)">{content}</div>
  ) : (
    content
  );
}

function TaskHeader({
  title = "Implement Paperclip protocol coverage",
}: {
  title?: string;
}) {
  return (
    <header className="flex flex-col gap-2 border-b border-border pb-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        PAP-16679 · In progress
      </div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">
        Codex · Paperclip Runner · default task interface
      </p>
    </header>
  );
}

function ThreadStory({
  items,
  disabledReason,
}: {
  items: TaskChatItem[];
  disabledReason?: string;
}) {
  return (
    <TaskPageFrame composerDisabledReason={disabledReason}>
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader />}
        items={items}
      />
    </TaskPageFrame>
  );
}

function RunnerTurnStory({
  items,
  status = "running",
  mobile = false,
}: {
  items: TaskChatItem[];
  status?: string;
  mobile?: boolean;
}) {
  const content = (
    <TaskPageFrame>
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader title="Inspect the active Paperclip runner" />}
        items={[
          {
            id: "request",
            kind: "message",
            author: "human",
            text: "Investigate this task and keep me updated as you work.",
            timestamp: "11:58 AM",
          },
        ]}
        tail={
          <TaskChatRunnerTurn
            runId="storybook-run"
            agentName="Runner"
            items={items}
            status={status}
            startedAtMs={Date.now() - 18_000}
            finishedAtMs={
              status === "running" || status === "queued" ? null : Date.now()
            }
          />
        }
      />
    </TaskPageFrame>
  );
  return mobile ? (
    <div className="mx-auto max-w-(--sz-390px)">{content}</div>
  ) : (
    content
  );
}

function providerActivity(
  family: TaskChatProviderActivityFamily,
  eventType: string,
  status: TaskChatProviderActivityItem["status"],
  overrides: Partial<TaskChatProviderActivityItem> = {},
): TaskChatProviderActivityItem {
  return {
    id: `provider-${family}`,
    kind: "protocol",
    surface: "provider_activity",
    family,
    eventType,
    status,
    title: family.replaceAll("_", " "),
    details: [],
    steps: [],
    links: [],
    children: [],
    ...overrides,
  };
}

const mixedLiveActivity: TaskChatItem[] = [
  {
    id: "commentary-1",
    kind: "message",
    author: "agent",
    text: "I’ll inspect the current implementation, then verify the live behavior.",
    interstitial: true,
    channel: "progress",
  },
  {
    id: "reasoning",
    kind: "thinking",
    lines: [
      "The runner has the normalized events; the missing piece is their live presentation.",
    ],
    streaming: false,
    channel: "summary",
  },
  {
    id: "read",
    kind: "tool",
    name: "Read",
    rawName: "read_file",
    target: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx",
    status: "completed",
    detail: "Read 324 lines",
  },
  providerActivity("research", "research.completed", "completed", {
    summary: "Codex live activity disclosure",
    details: [
      { label: "Query", value: "Codex live activity disclosure", mono: true },
    ],
    links: [
      {
        label: "App-server interaction notes",
        href: "https://example.com/app-server",
        description: "Provider-neutral lifecycle reference.",
      },
    ],
  }),
  {
    id: "commentary-2",
    kind: "message",
    author: "agent",
    text: "The event stream is complete. I’m wiring the compact rows now.",
    interstitial: true,
    channel: "progress",
  },
  {
    id: "workspace",
    kind: "protocol",
    surface: "workspace_change",
    changeSetId: "change-live",
    revision: 2,
    source: "runner_verified",
    complete: true,
    files: [
      {
        path: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx",
        operation: "modify",
        previousPath: null,
        additions: 42,
        deletions: 18,
        binary: false,
        diff: "@@ -1,2 +1,3 @@\n-static row\n+expandable activity\n+semantic timeline",
      },
    ],
    totals: { files: 1, additions: 42, deletions: 18 },
    patchArtifactRef: null,
  },
  {
    id: "test",
    kind: "tool",
    name: "Command",
    rawName: "bash",
    target: "pnpm vitest TaskChatRunnerTurn",
    status: "in_progress",
    detail: "82 tests running",
  },
];

const chronologicalTaskTurn: TaskChatItem[] = [
  {
    id: "timeline-commentary-1",
    kind: "message",
    author: "agent",
    text: "I’ll inspect the workspace and establish the first design boundary.",
    interstitial: true,
    channel: "progress",
  },
  {
    id: "timeline-read-1",
    kind: "tool",
    name: "Read",
    rawName: "read_file",
    target: "ui/src/components/task-chat/transcript-adapter.ts",
    status: "completed",
  },
  {
    id: "timeline-commentary-2",
    kind: "message",
    author: "agent",
    text: "The transcript is ordered correctly; I need the first product choices.",
    interstitial: true,
    channel: "progress",
  },
  runtimeQuestionReceipts[0]!,
  {
    id: "timeline-commentary-3",
    kind: "message",
    author: "agent",
    text: "With those answers in place, I’ll verify the next activity group.",
    interstitial: true,
    channel: "progress",
  },
  providerActivity("research", "research.completed", "completed", {
    id: "timeline-research",
    summary: "Codex chronological task timeline",
  }),
  runtimeQuestionReceipts[1]!,
  {
    id: "timeline-commentary-4",
    kind: "message",
    author: "agent",
    text: "The final implementation shape is now clear.",
    interstitial: true,
    channel: "progress",
  },
  {
    id: "timeline-test",
    kind: "tool",
    name: "Command",
    rawName: "bash",
    target: "pnpm vitest TaskChatRunnerTurn",
    status: "completed",
  },
  {
    id: "timeline-final",
    kind: "message",
    author: "agent",
    text: "The chronological task-turn timeline is implemented and verified.",
    channel: "final",
  },
];

const savedPlanDocument: IssueDocument = {
  id: "storybook-plan",
  companyId: "storybook-company",
  issueId: "storybook-issue",
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "# Plan preview and streaming reasoning\n\n- Extract the review preview into a shared card.\n- Stream provider plan and reasoning events in place.\n- Reconcile live Plan activity to the canonical revision.\n- Verify desktop and mobile task layouts.",
  latestRevisionId: "storybook-plan-revision-4",
  latestRevisionNumber: 4,
  createdByAgentId: "storybook-agent",
  createdByUserId: null,
  updatedByAgentId: "storybook-agent",
  updatedByUserId: null,
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: new Date("2026-08-23T11:50:00.000Z"),
  updatedAt: new Date("2026-08-23T12:00:00.000Z"),
};

const streamingPlanActivity = providerActivity(
  "plan",
  "plan.updated",
  "running",
  {
    title: "Plan",
    details: [{ label: "Revision", value: "5" }],
    steps: [
      {
        id: "plan-step-1",
        label: "Reuse the Plan review preview",
        status: "completed",
      },
      {
        id: "plan-step-2",
        label: "Stream provider-authored plan steps",
        status: "in_progress",
      },
      {
        id: "plan-step-3",
        label: "Reconcile the saved revision",
        status: "pending",
      },
    ],
    transcriptIndex: 3,
  },
);

const turnStatusWorkspace: TaskChatItem = {
  id: "turn-status-workspace",
  kind: "protocol",
  surface: "workspace_change",
  changeSetId: "storybook-run:workspace",
  revision: 4,
  source: "harness_reported",
  complete: false,
  files: [
    {
      path: "ui/src/components/task-chat/TaskChatTurnStatusIsland.tsx",
      operation: "create",
      previousPath: null,
      additions: 184,
      deletions: 0,
      binary: false,
      diff: null,
    },
    {
      path: "ui/src/components/TaskChatThread.tsx",
      operation: "modify",
      previousPath: null,
      additions: 16,
      deletions: 8,
      binary: false,
      diff: null,
    },
    {
      path: "packages/paperclip-runner/src/provider-events.ts",
      operation: "modify",
      previousPath: null,
      additions: 42,
      deletions: 21,
      binary: false,
      diff: null,
    },
  ],
  totals: { files: 3, additions: 242, deletions: 29 },
  patchArtifactRef: null,
};

const blockedTurnPlan = providerActivity("plan", "plan.updated", "running", {
  title: "Plan",
  steps: [
    {
      id: "blocked-step-1",
      label: "Inspect the existing runner protocol and its adapter boundaries",
      status: "completed",
    },
    {
      id: "blocked-step-2",
      label:
        "Resolve the unavailable provider capability before forwarding the structured checklist",
      status: "blocked",
    },
    {
      id: "blocked-step-3",
      label: "Render and verify the composer-adjacent turn status island",
      status: "pending",
    },
  ],
  transcriptIndex: 6,
});

function AdvancingTurnStatusStory() {
  const [phase, setPhase] = useState(0);
  const statuses = [
    ["in_progress", "pending", "pending"],
    ["completed", "in_progress", "pending"],
    ["completed", "completed", "in_progress"],
    ["completed", "completed", "completed"],
  ] as const;
  const steps = [
    "Inspect the event stream",
    "Build the status island",
    "Verify protocol and UI",
  ];
  const activity = providerActivity(
    "plan",
    "plan.updated",
    phase === 3 ? "completed" : "running",
    {
      title: "Plan",
      steps: steps.map((label, index) => ({
        id: `advancing-step-${index + 1}`,
        label,
        status: statuses[phase]![index]!,
      })),
      transcriptIndex: phase + 1,
    },
  );
  return (
    <div>
      <button
        type="button"
        className="fixed right-6 top-6 z-50 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm"
        onClick={() => setPhase((current) => (current + 1) % statuses.length)}
      >
        Advance checklist
      </button>
      <TurnStatusStory items={[activity, turnStatusWorkspace]} />
    </div>
  );
}

const longOpenCodeReasoning: TaskChatItem[] = [
  {
    id: "opencode-commentary",
    kind: "message",
    author: "agent",
    text: "I’m checking the thread model and the existing Plan review card.",
    interstitial: true,
    channel: "progress",
    transcriptIndex: 1,
  },
  {
    id: "opencode-reasoning",
    kind: "thinking",
    channel: "detail",
    streaming: true,
    transcriptIndex: 4,
    lines: [
      "The current Plan marker is a presentation-only item, so replacing it with a canonical document item does not require a protocol or persistence change.",
      "The folded runner can arbitrate provider-authored commentary and reasoning by the latest transcript event while the expanded activity list keeps both blocks available for inspection.",
      "The last visible line is intentionally much longer than the available row so the one-line OpenCode reasoning ticker demonstrates truncation without losing the complete provider trace in expanded history.",
    ],
  },
];

const commentaryReasoningAlternation: TaskChatItem[] = [
  {
    id: "alternation-commentary-1",
    kind: "message",
    author: "agent",
    text: "First I’ll inspect the Plan review component.",
    interstitial: true,
    channel: "progress",
    transcriptIndex: 1,
  },
  {
    id: "alternation-reasoning-1",
    kind: "thinking",
    lines: [
      "The review preview already has the correct information hierarchy.",
    ],
    channel: "summary",
    transcriptIndex: 2,
  },
  {
    id: "alternation-commentary-2",
    kind: "message",
    author: "agent",
    text: "The shared card is ready; now I’m testing stream reconciliation.",
    interstitial: true,
    channel: "progress",
    transcriptIndex: 3,
  },
  {
    id: "alternation-reasoning-2",
    kind: "thinking",
    lines: [
      "A canonical document updated after the run starts can safely replace the live provider draft.",
    ],
    channel: "detail",
    streaming: true,
    transcriptIndex: 4,
  },
];

const allProviderActivity: TaskChatItem[] = [
  providerActivity("plan", "plan.updated", "completed", {
    summary: "Three implementation steps",
    steps: [
      { id: "step-1", label: "Build disclosure", status: "completed" },
      { id: "step-2", label: "Add stories", status: "in_progress" },
    ],
  }),
  providerActivity("tool_execution", "tool.execution.completed", "completed", {
    summary: "pnpm vitest",
    output: "82 tests passed",
  }),
  providerActivity("research", "research.completed", "completed", {
    summary: "Paperclip protocol UX",
    links: [{ label: "Protocol notes", href: "https://example.com/protocol" }],
  }),
  providerActivity("delegation", "delegation.updated", "completed", {
    details: [{ label: "Action", value: "spawn" }],
    children: [
      {
        id: "child-1",
        title: "UI reviewer",
        status: "completed",
        summary: "Reviewed compact rows.",
      },
    ],
  }),
  providerActivity("model_identity", "model.route.changed", "informational", {
    summary: "gpt-5.6",
    details: [{ label: "Effective Model", value: "gpt-5.6", mono: true }],
  }),
  providerActivity("context", "context.compacted", "completed", {
    summary: "Context compacted",
  }),
  providerActivity("artifact", "artifact.generated", "completed", {
    summary: "runner-activity.png",
  }),
  providerActivity("review", "review.mode.changed", "informational", {
    details: [{ label: "State", value: "entered" }],
  }),
  providerActivity("hook", "hook.completed", "completed", {
    summary: "post-test",
  }),
  providerActivity("memory", "memory.citation.referenced", "informational", {
    summary: "Prior design decision",
  }),
  providerActivity("safety", "safety.review.completed", "completed", {
    summary: "Allowed",
  }),
  providerActivity("terminal", "terminal.input.sent", "informational", {
    summary: "Control input",
  }),
  providerActivity("wait", "wait.started", "running", {
    summary: "Provider backoff",
  }),
  providerActivity(
    "provider_notice",
    "provider.notice.recorded",
    "informational",
    { summary: "Throughput temporarily reduced" },
  ),
];

const searchResultsAndFileChanges: TaskChatItem[] = [
  providerActivity("research", "research.completed", "completed", {
    summary:
      "site:nextjs.org/docs/app/api-reference/config/eslint Next.js 16 eslint.config.mjs core-web-vitals typescript",
    details: [
      { label: "Action", value: "search" },
      { label: "Status", value: "completed" },
      {
        label: "Query",
        value:
          "site:nextjs.org/docs/app/api-reference/config/eslint Next.js 16 eslint.config.mjs core-web-vitals typescript",
        mono: true,
      },
    ],
    links: [
      {
        label: "Configuration: ESLint | Next.js",
        href: "https://nextjs.org/docs/app/api-reference/config/eslint",
        description:
          "Configure ESLint in the App Router and understand the current defaults.",
      },
      {
        label: "next.config.js: eslint | Next.js",
        href: "https://nextjs.org/docs/pages/api-reference/config/next-config-js/eslint",
        description: "Legacy configuration behavior and migration notes.",
      },
      {
        label: "Configuration: TypeScript | Next.js",
        href: "https://nextjs.org/docs/app/api-reference/config/typescript",
        description:
          "TypeScript configuration options for modern Next.js applications.",
      },
      {
        label: "Upgrading: Codemods | Next.js",
        href: "https://nextjs.org/docs/app/guides/upgrading/codemods",
        description:
          "Automated migrations for eslint.config.mjs and current conventions.",
      },
      {
        label: "API Reference: Configuration | Next.js",
        href: "https://nextjs.org/docs/app/api-reference/config",
        description: "The complete application configuration reference.",
      },
      {
        label: "Next.js 16 upgrade guide",
        href: "https://nextjs.org/docs/app/guides/upgrading/version-16",
        description:
          "Breaking changes and recommended upgrade steps for version 16.",
      },
      {
        label: "Core Web Vitals",
        href: "https://nextjs.org/docs/app/api-reference/functions/use-report-web-vitals",
        description: "Measure and report application performance metrics.",
      },
    ],
  }),
  {
    id: "file-change-search-story",
    kind: "tool",
    name: "File change",
    rawName: "file_change",
    target: "/Users/runner/workspaces/example/tsconfig.json",
    status: "completed",
    diff: {
      path: "tsconfig.json",
      added: 228,
      removed: 0,
      lines: Array.from({ length: 24 }, (_, index) => ({
        kind: "add" as const,
        text: `generated diff line ${index + 1}`,
      })),
    },
  },
];

function RunnerTransitionStory() {
  const [phase, setPhase] = useState(0);
  const items: TaskChatItem[] =
    phase === 0
      ? [
          {
            id: "reasoning-lifecycle",
            kind: "thinking",
            lines: [],
            streaming: true,
            lifecycleOnly: true,
          },
        ]
      : phase === 1
        ? mixedLiveActivity.slice(0, 4)
        : phase === 2
          ? mixedLiveActivity
          : [
              ...mixedLiveActivity.map((item) =>
                item.kind === "tool" && item.id === "test"
                  ? {
                      ...item,
                      status: "completed" as const,
                      detail: "82 tests passed",
                    }
                  : item,
              ),
              {
                id: "final",
                kind: "message",
                author: "agent",
                authorName: "Runner",
                text: "The live activity disclosure is implemented and verified.",
                channel: "final",
              },
            ];
  const status = phase === 3 ? "succeeded" : "running";
  return (
    <div className="flex flex-col gap-3">
      <div className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-wrap gap-2 px-4 pt-3">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setPhase(1)}
        >
          Add research
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setPhase(2)}
        >
          Add tool activity
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setPhase(3)}
        >
          Finish run
        </button>
      </div>
      <RunnerTurnStory items={items} status={status} />
    </div>
  );
}

function RuntimeRequestStory() {
  const [items, setItems] = useState<TaskChatItem[]>([
    pendingRuntimePermission,
  ]);
  const [dismissed, setDismissed] = useState(false);
  const resolve = (request: TaskChatRuntimeRequestItem) =>
    setItems((current) =>
      current.map((item) =>
        item.id === request.id &&
        item.kind === "protocol" &&
        item.surface === "runtime_request"
          ? { ...item, status: "resolved" }
          : item,
      ),
    );
  const pending = items.find(
    (item): item is TaskChatRuntimeRequestItem =>
      item.kind === "protocol" &&
      item.surface === "runtime_request" &&
      item.status === "pending",
  );
  return (
    <TaskPageFrame
      takeover={
        pending && !dismissed
          ? {
              id: pending.id,
              label: "Runtime permission",
              pendingCount: 1,
              content: (
                <TaskChatProtocolCard
                  item={pending}
                  presentation="takeover"
                  onRuntimeRequestDecision={resolve}
                />
              ),
              onDismiss: () => setDismissed(true),
              onSkip: () => resolve(pending),
              hideSkip: runtimeRequestReplacesComposerSkip(pending),
            }
          : null
      }
      pendingTakeover={
        pending && dismissed
          ? {
              count: 1,
              label: "Return to runtime permission",
              onOpen: () => setDismissed(false),
            }
          : null
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader />}
        items={items.filter(
          (item) =>
            item.kind !== "protocol" || item.surface !== "runtime_request",
        )}
        tail={
          <TaskChatRunnerTurn
            runId="storybook-run"
            agentName="Runner"
            items={items}
            status="running"
            startedAtMs={Date.now() - 8_000}
          />
        }
      />
    </TaskPageFrame>
  );
}

function RuntimeInputStory() {
  const [items, setItems] = useState<TaskChatItem[]>([pendingRuntimeTextInput]);
  const [dismissed, setDismissed] = useState(false);
  const resolve = (request: TaskChatRuntimeRequestItem) =>
    setItems((current) =>
      current.map((item) =>
        item.id === request.id &&
        item.kind === "protocol" &&
        item.surface === "runtime_request"
          ? { ...item, status: "resolved" }
          : item,
      ),
    );
  const pending = items.find(
    (item): item is TaskChatRuntimeRequestItem =>
      item.kind === "protocol" &&
      item.surface === "runtime_request" &&
      item.status === "pending",
  );
  return (
    <TaskPageFrame
      takeover={
        pending && !dismissed
          ? {
              id: pending.id,
              label: "Runtime input",
              pendingCount: 1,
              content: (
                <TaskChatProtocolCard
                  item={pending}
                  presentation="takeover"
                  onRuntimeRequestDecision={resolve}
                />
              ),
              onDismiss: () => setDismissed(true),
              onSkip: () => resolve(pending),
              hideSkip: runtimeRequestReplacesComposerSkip(pending),
            }
          : null
      }
      pendingTakeover={
        pending && dismissed
          ? {
              count: 1,
              label: "Return to runtime input",
              onOpen: () => setDismissed(false),
            }
          : null
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader />}
        items={items.filter(
          (item) =>
            item.kind !== "protocol" || item.surface !== "runtime_request",
        )}
        tail={
          <TaskChatRunnerTurn
            runId="storybook-run"
            agentName="Runner"
            items={items}
            status="running"
            startedAtMs={Date.now() - 8_000}
          />
        }
      />
    </TaskPageFrame>
  );
}

function InteractionStory() {
  const [question, setQuestion] = useState(pendingAskUserQuestionsInteraction);
  const [takeoverOpen, setTakeoverOpen] = useState(true);
  const items: TaskChatItem[] = [
    {
      id: "human",
      kind: "message",
      author: "human",
      text: "Inventory the task-page protocol interactions.",
      timestamp: "11:58 AM",
    },
    ...[
      pendingSuggestedTasksInteraction,
      pendingRequestConfirmationInteraction,
      pendingRequestCheckboxConfirmationInteraction,
      pendingRequestItemVerdictsInteraction,
      question,
    ].map((interaction) => ({
      id: `interaction:${interaction.id}`,
      kind: "interaction" as const,
      interaction,
    })),
  ];
  return (
    <TaskPageFrame
      takeover={
        question.status === "pending" && takeoverOpen
          ? {
              id: question.id,
              label: question.title ?? "Questions",
              pendingCount: 5,
              content: (
                <TaskChatInteractionCard
                  item={{
                    id: `interaction:${question.id}`,
                    kind: "interaction",
                    interaction: question,
                  }}
                  presentation="takeover"
                  agentMap={storybookAgentMap}
                  currentUserId={
                    issueThreadInteractionFixtureMeta.currentUserId
                  }
                  userLabelMap={boardUserLabels}
                  onSubmitInteractionAnswers={(interaction) => {
                    if (interaction.id === question.id)
                      setQuestion(answeredAskUserQuestionsInteraction);
                  }}
                />
              ),
              onDismiss: () => setTakeoverOpen(false),
              onSkip: () => undefined,
              inlineSkip: true,
            }
          : null
      }
      pendingTakeover={
        question.status === "pending" && !takeoverOpen
          ? {
              count: 1,
              label: "Return to pending questions",
              onOpen: () => setTakeoverOpen(true),
            }
          : null
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader title="Resolve protocol interactions" />}
        items={items}
        renderInteraction={(item) => (
          <TaskChatInteractionCard
            item={item}
            agentMap={storybookAgentMap}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
            userLabelMap={boardUserLabels}
            onAcceptInteraction={() => undefined}
            onRejectInteraction={() => undefined}
            onSubmitInteractionAnswers={(interaction) => {
              if (interaction.id === question.id)
                setQuestion(answeredAskUserQuestionsInteraction);
            }}
            onCancelInteraction={() => undefined}
            onSubmitInteractionVerdicts={() => undefined}
          />
        )}
      />
    </TaskPageFrame>
  );
}

const meta = {
  title: "Task Page/Runner Protocol",
  component: TaskChatThreadView,
  args: { items: [] },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskChatThreadView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderSemantics: Story = {
  render: () => <ThreadStory items={protocolItems(providerEvents)} />,
};
export const WorkspaceChanges: Story = {
  render: () => (
    <RunnerTurnStory items={protocolItems(workspaceEvents)} status="succeeded" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-workspace-change")).toHaveTextContent(
      "4 files changed · +16 −1",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Review diff" }),
    );
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await expect(dialog).toHaveTextContent("ui/src/App.tsx");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "ui/src/new-card.tsx" }),
    );
    await expect(dialog).toHaveTextContent("export function Card");
  },
};
export const WorkspaceChangesInProgress: Story = {
  render: () => (
    <RunnerTurnStory items={protocolItems(workspaceEvents)} status="succeeded" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId("task-chat-workspace-change")).toHaveLength(1);
    await expect(canvas.getByTestId("task-chat-workspace-change")).toHaveTextContent(
      "4 files changed · +16 −1",
    );
    await expect(canvas.queryByText("Workspace changes in progress")).not.toBeInTheDocument();
  },
};
export const Dot220WorkspaceChanges: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems(dot220WorkspaceEvents)}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cards = canvas.getAllByTestId("task-chat-workspace-change");
    await expect(cards).toHaveLength(1);
    await expect(cards[0]).toHaveTextContent("7 files changed · +41 −0");
    await expect(cards[0]).toHaveTextContent("README.md");
    await expect(canvasElement.textContent).not.toContain("/Users/dotta/");
  },
};
export const WorkspaceChangesManyFiles: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("many-files:workspace", manyWorkspaceFiles),
      ])}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: `Show ${manyWorkspaceFiles.length - 3} more files` }),
    );
    await expect(canvas.getByText("ui/public/workspace-preview.png")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Review diff" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "public/game.js" }),
    );
    await expect(dialog).toHaveTextContent("public/game.js");
  },
};
export const WorkspaceChangeRename: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("rename:workspace", [manyWorkspaceFiles[7]!]),
      ])}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/LegacyWorkspacePanel\.tsx →/)).toBeVisible();
    await expect(canvas.getByText("rename")).toBeVisible();
  },
};
export const WorkspaceChangeDelete: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("delete:workspace", [manyWorkspaceFiles[8]!]),
      ])}
      status="succeeded"
    />
  ),
};
export const WorkspaceChangeBinary: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("binary:workspace", [manyWorkspaceFiles[9]!]),
      ])}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("binary · modify")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Review diff" }));
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("dialog"),
    ).toHaveTextContent("Binary file; text diff is unavailable.");
  },
};
export const WorkspaceChangeEmptyDiff: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("empty:workspace", [], {
          totals: { files: 0, additions: 0, deletions: 0 },
        }),
      ])}
      status="succeeded"
    />
  ),
};
export const WorkspaceChangeTruncatedPatch: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems([
        workspaceStateEvent("truncated:workspace", [{
          ...dot220Files[0]!,
          diff: `diff --git a/README.md b/README.md\n${"+generated line\n".repeat(800)}`,
        }]),
      ])}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Review diff" }),
    );
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("dialog"),
    ).toHaveTextContent("patch truncated for display");
  },
};
export const WorkspaceChangesMobile: Story = {
  render: () => (
    <RunnerTurnStory
      items={protocolItems(dot220WorkspaceEvents)}
      status="succeeded"
      mobile
    />
  ),
};
export const WorkspaceChangesFullTaskTurn: Story = {
  render: () => (
    <RunnerTurnStory
      items={[
        {
          id: "inspect-commentary",
          kind: "message",
          author: "agent",
          text: "I’ll inspect the current implementation first.",
          interstitial: true,
          channel: "progress",
        },
        {
          id: "read-tool",
          kind: "tool",
          name: "Read",
          rawName: "read_file",
          target: "ui/src/components/task-chat/TaskChatProtocolCard.tsx",
          status: "completed",
        },
        ...protocolItems(dot220WorkspaceEvents),
      ]}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByTestId("task-chat-workspace-change");
    await expect(card.closest('[data-testid="task-chat-activity-phase"]')).toBeNull();
    await expect(canvas.getAllByTestId("task-chat-workspace-change")).toHaveLength(1);
  },
};
export const FileReferences: Story = {
  render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Preview" }),
    );
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("dialog"),
    ).toHaveTextContent("Paperclip Runner Protocol");
  },
};
export const RuntimeRequests: Story = {
  name: "Runtime Permission / Resolve Interaction",
  render: () => <RuntimeRequestStory />,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Allow once" }),
    );
    await expect(
      within(canvasElement).getByTestId("task-chat-runtime-request"),
    ).toHaveTextContent("resolved");
  },
};
export const RuntimeInput: Story = {
  name: "Runtime Text Input / Resolve Interaction",
  render: () => <RuntimeInputStory />,
  play: async ({ canvasElement }) => {
    await userEvent.type(
      within(canvasElement).getByLabelText("Environment"),
      "production",
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Submit response" }),
    );
    await expect(
      within(canvasElement).getByTestId("task-chat-runtime-request"),
    ).toHaveTextContent("resolved");
  },
};
export const RuntimeQuestionReceipts: Story = {
  name: "Runtime Input / Resolved + Cancelled Receipts",
  render: () => <RunnerTurnStory items={runtimeQuestionReceipts} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const receipts = canvas.getAllByTestId(
      "task-chat-runtime-request",
    ) as HTMLDetailsElement[];
    await expect(receipts).toHaveLength(2);
    await expect(
      within(receipts[0]).getByText("Questions answered"),
    ).toBeVisible();
    await expect(
      within(receipts[1]).getByText("Questions cancelled"),
    ).toBeVisible();
    await expect(receipts[0].open).toBe(false);
    await userEvent.click(within(receipts[0]).getByText("Questions answered"));
    await expect(receipts[0].open).toBe(true);
    await expect(
      within(receipts[0]).getByText("Colony survival"),
    ).toBeVisible();
    await userEvent.click(within(receipts[0]).getByText("Questions answered"));
    await expect(receipts[0].open).toBe(false);
  },
};
export const Interactions: Story = { render: () => <InteractionStory /> };
export const ResultsAndTerminalStates: Story = {
  render: () => <ThreadStory items={protocolItems(resultEvents.slice(1))} />,
};
export const DesktopKitchenSink: Story = {
  render: () => (
    <ThreadStory
      items={[
        {
          id: "request",
          kind: "message",
          author: "human",
          text: "Implement and verify the Paperclip protocol task-page surfaces.",
          timestamp: "11:58 AM",
        },
        ...protocolItems([
          ...providerEvents.slice(0, 4),
          ...workspaceEvents,
          fileReferenceEvent,
          ...resultEvents,
        ]),
      ]}
      disabledReason="Waiting for a runtime decision"
    />
  ),
};
export const MobileKitchenSink: Story = {
  render: () => (
    <div className="mx-auto max-w-(--sz-390px)">
      <ThreadStory
        items={protocolItems([
          ...providerEvents.slice(0, 3),
          ...workspaceEvents,
          fileReferenceEvent,
        ])}
      />
    </div>
  ),
};

// Named regression stories match the Runner Lab qualifications that first
// exposed the production task-page gaps.
export const FrFileReference: Story = {
  render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} />,
};
export const WcWorkspaceChanges: Story = {
  render: () => <ThreadStory items={protocolItems(workspaceEvents)} />,
};
export const PendingQuestions: Story = {
  render: () => <InteractionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const questionCard = canvas
      .getByText("Resolve open UX decisions before Phase 1")
      .closest("article");
    if (!questionCard)
      throw new Error("Question interaction card did not render");
    const questions = within(questionCard);
    await userEvent.click(
      questions.getByText("Only collapse hidden descendants"),
    );
    await userEvent.click(questions.getByRole("button", { name: "Next" }));
    await userEvent.click(questions.getByText("Inline answer pills"));
    await userEvent.click(
      questions.getByRole("button", { name: "Send answers" }),
    );
    await waitFor(() => {
      expect(
        canvas.queryByRole("button", { name: "Send answers" }),
      ).not.toBeInTheDocument();
      expect(
        canvas
          .getAllByTestId("interaction-status-badge")
          .some(
            (badge) => badge.textContent?.trim().toLowerCase() === "answered",
          ),
      ).toBe(true);
    });
  },
};
export const CmProviderLabels: Story = {
  render: () => (
    <ThreadStory
      items={protocolItems([
        prp("model.route.changed", {
          routeId: "cm-route",
          provider: "claude",
          requestedModel: "claude",
          fromModel: null,
          effectiveModel: "Claude Sonnet",
          reason: "Managed provider label",
        }),
        prp("model.verification.updated", {
          verificationId: "cm-verify",
          status: "completed",
          classes: ["managed"],
          buffering: false,
          summary: "Provider-neutral label verified",
        }),
      ])}
    />
  ),
};

export const RunnerThinkingNoEvents: Story = {
  name: "Runner Activity / Thinking / No Events",
  render: () => (
    <RunnerTurnStory
      items={[
        {
          id: "reasoning-lifecycle",
          kind: "thinking",
          lines: [],
          streaming: true,
          lifecycleOnly: true,
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByTestId("task-chat-current-activity"),
    ).toHaveTextContent("Thinking");
    await expect(
      canvas.queryByTestId("task-chat-current-activity-icon"),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByTestId("task-chat-runner-disclosure-caret"),
    ).not.toBeInTheDocument();
  },
};

export const RunnerWorkingIdentityRow: Story = {
  name: "Runner Identity / Working Status",
  render: () => (
    <RunnerTurnStory
      items={[
        {
          id: "working-commentary",
          kind: "message",
          author: "agent",
          text: "I’m checking the implementation and its Storybook coverage.",
          interstitial: true,
          channel: "progress",
          streaming: true,
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const identityRow = canvas.getByTestId("task-chat-runner-identity-row");
    const status = canvas.getByTestId("task-chat-turn-status-header");
    await expect(within(identityRow).getByText("Runner")).toBeVisible();
    await expect(status).toHaveTextContent("Working for");
    await expect(status).toHaveAttribute("data-turn-position", "identity");
    await expect(status.parentElement).toBe(identityRow);
  },
};

export const RunnerWorkedIdentityRow: Story = {
  name: "Runner Identity / Worked Status After Refresh",
  render: () => (
    <ThreadStory
      items={[
        {
          id: "worked-request",
          kind: "message",
          author: "human",
          text: "Verify the persisted task history after a refresh.",
          timestamp: "9:15 AM",
        },
        {
          id: "worked-durable-turn",
          kind: "turn",
          settled: true,
          standaloneHeader: true,
          agentName: "Runner",
          agentIcon: "terminal",
          summary: {
            durationLabel: "18s",
            toolCount: 0,
            added: 0,
            removed: 0,
          },
          items: [],
          finalResponse: {
            id: "worked-final",
            kind: "message",
            author: "agent",
            text: "The implementation and Storybook coverage are complete.",
            channel: "final",
          },
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const identityRow = canvas.getByTestId("task-chat-turn-summary");
    await expect(within(identityRow).getByText("Runner")).toBeVisible();
    await expect(identityRow).toHaveTextContent("Worked for");
    await expect(
      within(identityRow).getByTestId("task-chat-agent-avatar"),
    ).toBeVisible();
    await expect(identityRow).toHaveAttribute("data-turn-position", "identity");
  },
};

export const SavedPlanPreview: Story = {
  name: "Plan Preview / Saved Revision",
  render: () => (
    <ThreadStory
      items={[
        {
          id: "saved-plan",
          kind: "plan_document",
          document: savedPlanDocument,
        },
      ]}
    />
  ),
};

export const SavedPlanPreviewMobile: Story = {
  name: "Plan Preview / Saved Revision / Mobile",
  render: () => (
    <div className="mx-auto max-w-(--sz-390px)">
      <ThreadStory
        items={[
          {
            id: "saved-plan-mobile",
            kind: "plan_document",
            document: savedPlanDocument,
          },
        ]}
      />
    </div>
  ),
};

export const RunnerStreamingPlanSteps: Story = {
  name: "Turn Status Island / Plan Only",
  render: () => <TurnStatusStory items={[streamingPlanActivity]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const island = canvas.getByTestId("task-chat-turn-status-island");
    await expect(island).toHaveTextContent("Step 2 / 3");
    await userEvent.hover(island);
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      body.getByRole("list", { name: "Within-turn checklist" }),
    ).toHaveTextContent("Stream provider-authored plan steps");
    await userEvent.click(
      canvas.getByRole("button", { name: /expand activity/i }),
    );
    await expect(
      canvas.getByTestId("task-chat-runner-activity-list"),
    ).toHaveTextContent("Plan");
  },
};

export const TurnStatusPlanAndDiff: Story = {
  name: "Turn Status Island / Plan + Diff",
  render: () => (
    <TurnStatusStory items={[streamingPlanActivity, turnStatusWorkspace]} />
  ),
};

export const TurnStatusDiffOnly: Story = {
  name: "Turn Status Island / Diff Only",
  render: () => <TurnStatusStory items={[turnStatusWorkspace]} />,
};

export const TurnStatusAllCompleted: Story = {
  name: "Turn Status Island / All Completed",
  render: () => (
    <TurnStatusStory
      items={[
        providerActivity("plan", "plan.updated", "completed", {
          steps: [
            {
              id: "complete-1",
              label: "Inspect the protocol",
              status: "completed",
            },
            {
              id: "complete-2",
              label: "Build the component",
              status: "completed",
            },
            {
              id: "complete-3",
              label: "Run verification",
              status: "completed",
            },
          ],
        }),
      ]}
    />
  ),
};

export const TurnStatusBlockedAndLong: Story = {
  name: "Turn Status Island / Blocked + Long Labels",
  render: () => <TurnStatusStory items={[blockedTurnPlan]} />,
};

export const TurnStatusMobile: Story = {
  name: "Turn Status Island / Mobile",
  render: () => (
    <TurnStatusStory
      items={[streamingPlanActivity, turnStatusWorkspace]}
      mobile
    />
  ),
};

export const TurnStatusChangingSnapshots: Story = {
  name: "Turn Status Island / Changing Snapshots",
  render: () => <AdvancingTurnStatusStory />,
};

export const TurnStatusNoData: Story = {
  name: "Turn Status Island / No Data",
  render: () => <TurnStatusStory items={[]} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByTestId("task-chat-turn-status-island"),
    ).not.toBeInTheDocument();
  },
};

export const TurnStatusTerminal: Story = {
  name: "Turn Status Island / Terminal",
  render: () => (
    <TurnStatusStory
      items={[streamingPlanActivity, turnStatusWorkspace]}
      status="succeeded"
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByTestId("task-chat-turn-status-island"),
    ).not.toBeInTheDocument();
    await expect(
      within(canvasElement).getByTestId("task-chat-runner-turn"),
    ).toBeInTheDocument();
  },
};

export const RunnerLongOpenCodeReasoning: Story = {
  name: "Runner Activity / Reasoning / Long OpenCode Trace",
  render: () => <RunnerTurnStory items={longOpenCodeReasoning} />,
};

export const RunnerCommentaryReasoningAlternation: Story = {
  name: "Runner Activity / Reasoning / Commentary Alternation",
  render: () => <RunnerTurnStory items={commentaryReasoningAlternation} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByTestId("task-chat-phase-interstitial"),
    ).toHaveLength(2);
    for (const disclosure of canvas.getAllByRole("button", {
      name: /expand activity/i,
    })) {
      await userEvent.click(disclosure);
    }
    await expect(canvas.getAllByTestId("task-chat-thinking")).toHaveLength(2);
  },
};

export const RunnerChronologicalTaskTurn: Story = {
  name: "Runner Activity / Timeline / Commentary, Tools, and Questions",
  render: () => (
    <RunnerTurnStory items={chronologicalTaskTurn} status="succeeded" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByTestId("task-chat-turn-timeline-row");
    await expect(
      rows.map((row) => row.getAttribute("data-timeline-row-id")),
    ).toEqual([
      "timeline-commentary-1:phase",
      "timeline-commentary-2:phase",
      "runtime-question-resolved",
      "timeline-commentary-3:phase",
      "runtime-question-cancelled",
      "timeline-commentary-4:phase",
    ]);
    await expect(
      canvas.getAllByTestId("task-chat-phase-interstitial"),
    ).toHaveLength(4);
    await expect(canvas.getAllByTestId("task-chat-phase-summary")).toHaveLength(
      3,
    );
    await expect(
      canvas.getAllByTestId("task-chat-runtime-request"),
    ).toHaveLength(2);
    await expect(
      canvas.getByTestId("task-chat-turn-status-header"),
    ).toHaveTextContent("Worked for");
    const request = canvas.getByText(
      "Investigate this task and keep me updated as you work.",
    );
    const statusHeader = canvas.getByTestId("task-chat-turn-status-header");
    const timeline = canvas.getByTestId("task-chat-turn-timeline");
    await expect(statusHeader).toHaveAttribute(
      "data-turn-position",
      "identity",
    );
    await expect(
      request.compareDocumentPosition(statusHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      statusHeader.compareDocumentPosition(timeline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      canvas.getByTestId("task-chat-final-response"),
    ).toHaveTextContent("implemented and verified");
  },
};

export const RunnerLiveCollapsedHover: Story = {
  name: "Runner Activity / Live / Collapsed Hover",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getAllByRole("button", {
      name: /expand activity/i,
    })[0]!;
    const representativeIcon = within(disclosure).getByTestId(
      "task-chat-phase-summary-icon",
    );
    const caret = within(disclosure).getByTestId(
      "task-chat-phase-summary-caret",
    );
    await expect(disclosure).toHaveClass("min-h-8", "text-muted-foreground");
    await expect(representativeIcon).toBeInTheDocument();
    await expect(caret).toHaveClass("ml-auto", "opacity-0");
    await userEvent.hover(disclosure);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  },
};

export const RunnerLiveExpandedMixedActivity: Story = {
  name: "Runner Activity / Live / Expanded Mixed Activity",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosures = canvas.getAllByRole("button", {
      name: /expand activity/i,
    });
    const disclosure = disclosures[0]!;
    disclosure.focus();
    await expect(disclosure).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(
      canvas.getByRole("list", { name: "Run activity" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getAllByTestId("task-chat-phase-interstitial"),
    ).toHaveLength(2);
    const centerX = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left + bounds.width / 2;
    };
    const avatarCenter = centerX(canvas.getByTestId("task-chat-agent-avatar"));
    const railCenter = centerX(
      canvas.getByTestId("task-chat-runner-activity-rail"),
    );
    await expect(Math.abs(avatarCenter - railCenter)).toBeLessThanOrEqual(1);
    const activityIconCenters = [
      canvas.getByTestId("task-chat-current-activity-icon"),
      canvas.getByTestId("task-chat-thinking-icon"),
      ...canvas.getAllByTestId("task-chat-tool-icon"),
      ...canvas.getAllByTestId("task-chat-protocol-activity-icon"),
    ].map(centerX);
    await expect(
      Math.max(...activityIconCenters) - Math.min(...activityIconCenters),
    ).toBeLessThanOrEqual(1);
    await expect(
      Math.min(...activityIconCenters) - railCenter,
    ).toBeGreaterThanOrEqual(16);
    await expect(disclosure).not.toHaveClass("focus-visible:ring-2");
  },
};

export const RunnerExpandedNestedTools: Story = {
  name: "Runner Activity / Nested Tools / Expanded Completion Tool",
  render: () => (
    <ThreadStory
      items={[
        {
          id: "nested-tool-turn",
          kind: "turn",
          settled: true,
          standaloneHeader: true,
          agentName: "Runner",
          agentIcon: "terminal",
          summary: {
            durationLabel: "18s",
            toolCount: 1,
            added: 0,
            removed: 0,
          },
          items: [
            {
              id: "nested-tool-phase",
              kind: "activity_phase",
              summary: "Used a tool",
              active: false,
              items: [
                {
                  id: "paperclip-finish",
                  kind: "tool",
                  name: "Reported completion",
                  rawName: "paperclip_finish",
                  target: "paperclip_finish",
                  status: "completed",
                  detail:
                    "Transport\tdynamic\nOperation\tunknown\nName\tpaperclip_finish\nStatus\tcompleted\nOutput Bytes\t0\nDuration Ms\t235",
                },
              ],
            },
          ],
          finalResponse: {
            id: "nested-tool-final",
            kind: "message",
            author: "agent",
            text: "The requested work is complete.",
            channel: "final",
          },
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const phaseDisclosure = canvas.getByRole("button", {
      name: "Expand activity: Used a tool",
    });
    await userEvent.click(phaseDisclosure);
    const toolDisclosure = canvas.getByRole("button", {
      name: "Reported completion paperclip_finish",
    });
    await userEvent.click(toolDisclosure);
    await expect(phaseDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");

    const phaseLabel = within(phaseDisclosure).getByText("Used a tool");
    const toolLabel = within(toolDisclosure).getByText("Reported completion");
    const toolName = within(toolDisclosure).getByText("paperclip_finish");
    const toolIcon = within(toolDisclosure).getByTestId("task-chat-tool-icon");
    const detail =
      canvasElement.querySelector<HTMLElement>(".tc-enter-tool pre");
    if (!detail) throw new Error("Expanded tool details did not render");

    const phaseLeft = phaseLabel.getBoundingClientRect().left;
    const toolLeft = toolLabel.getBoundingClientRect().left;
    await expect(Math.abs(phaseLeft - toolLeft)).toBeLessThanOrEqual(1);
    await expect(
      Math.abs(
        toolLabel.getBoundingClientRect().bottom -
          toolName.getBoundingClientRect().bottom,
      ),
    ).toBeLessThanOrEqual(1);
    const iconBounds = toolIcon.getBoundingClientRect();
    const detailBounds = detail.getBoundingClientRect();
    const borderWidth = Number.parseFloat(
      getComputedStyle(detail).borderLeftWidth,
    );
    await expect(
      Math.abs(
        (iconBounds.left + iconBounds.right) / 2 -
          (detailBounds.left + borderWidth / 2),
      ),
    ).toBeLessThanOrEqual(1);
    toolDisclosure.blur();
  },
};

export const RunnerLiveAllProviderFamilies: Story = {
  name: "Runner Activity / Live / All Provider Families",
  render: () => <RunnerTurnStory items={allProviderActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /expand activity/i }),
    );
    await expect(
      canvas.getAllByTestId("task-chat-protocol-activity-row"),
    ).toHaveLength(14);
    for (const family of [
      "plan",
      "tool_execution",
      "research",
      "delegation",
      "model_identity",
      "context",
      "artifact",
      "review",
      "hook",
      "memory",
      "safety",
      "terminal",
      "wait",
      "provider_notice",
    ]) {
      await expect(
        canvas
          .getByTestId("task-chat-runner-activity-list")
          .querySelector(`[data-activity-family="${family}"]`),
      ).not.toBeNull();
    }
    const planRow = canvas
      .getByTestId("task-chat-runner-activity-list")
      .querySelector<HTMLElement>('[data-activity-family="plan"]');
    if (!planRow) throw new Error("Plan activity row did not render");
    await userEvent.click(within(planRow).getByRole("button"));
    await expect(
      within(planRow).getByRole("list", { name: "Plan steps" }),
    ).toBeInTheDocument();
  },
};

export const RunnerLiveSearchResultsAndFileChanges: Story = {
  name: "Runner Activity / Live / Search Results and File Changes",
  render: () => <RunnerTurnStory items={searchResultsAndFileChanges} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /expand activity/i }),
    );
    const list = canvas.getByTestId("task-chat-runner-activity-list");
    const researchRow = list.querySelector<HTMLElement>(
      '[data-activity-family="research"]',
    );
    if (!researchRow) throw new Error("Research activity row did not render");
    await userEvent.click(within(researchRow).getByRole("button"));
    const toolRow = Array.from(
      list.querySelectorAll<HTMLElement>(".tc-enter-tool"),
    ).find((row) => row.textContent?.includes("File change"));
    if (!toolRow) throw new Error("File change tool row did not render");
    await userEvent.click(within(toolRow).getByRole("button"));

    await expect(
      canvas.getByTestId("task-chat-research-query"),
    ).toHaveTextContent("eslint.config.mjs");
    await expect(
      canvas
        .getByRole("list", { name: "Research sources" })
        .querySelectorAll("li"),
    ).toHaveLength(5);
    await expect(canvas.getByText("Show 2 more results")).toBeVisible();
    await expect(
      canvas.getByTestId("task-chat-tool-change-summary"),
    ).toHaveTextContent("+228 −0");
    await expect(
      canvas.queryByText("generated diff line 1"),
    ).not.toBeInTheDocument();
  },
};

export const RunnerLiveCommentaryAndStreamingUpdates: Story = {
  name: "Runner Activity / Live / Commentary and Streaming Updates",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const commentary = canvas.getAllByTestId("task-chat-phase-interstitial");
    await expect(commentary[0]).toHaveTextContent(
      "inspect the current implementation",
    );
    await expect(commentary[1]).toHaveTextContent("wiring the compact rows");
  },
};

export const RunnerLiveRuntimeRequest: Story = {
  name: "Runner Activity / Live / Pending Request Is Composer-Only",
  render: () => (
    <RunnerTurnStory
      items={[
        {
          id: "request-live",
          kind: "protocol",
          surface: "runtime_request",
          runId: "storybook-running",
          requestId: "request-live",
          requestKind: "command_approval",
          turnId: "turn-live",
          requestType: "permission",
          status: "pending",
          prompt: "Allow the verification command to run?",
          choices: [
            { key: "accept", label: "Allow once" },
            { key: "decline", label: "Deny" },
          ],
          fields: [],
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByTestId("task-chat-runtime-request"),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByTestId("task-chat-current-activity"),
    ).toHaveTextContent("Thinking");
  },
};

export const RunnerTransitionRunningToFinal: Story = {
  name: "Runner Activity / Transition / Running to Final",
  render: () => <RunnerTransitionStory />,
};

export const RunnerTerminalFailedOrInterrupted: Story = {
  name: "Runner Activity / Terminal / Failed or Interrupted",
  render: () => (
    <RunnerTurnStory
      status="failed"
      items={[
        {
          id: "command-failed",
          kind: "tool",
          name: "Command",
          rawName: "bash",
          target: "pnpm test",
          status: "failed",
          detail: "Tests exited with code 1",
        },
        {
          id: "interrupted",
          kind: "marker",
          variant: "interrupted",
          label: "Run interrupted",
          detail: "Provider connection closed",
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByTestId("task-chat-turn-status-header"),
    ).toHaveTextContent("Stopped after");
    await userEvent.click(
      canvas.getByRole("button", { name: /expand activity/i }),
    );
    await expect(
      canvas.getByTestId("task-chat-runner-activity-list"),
    ).toHaveTextContent("Run interrupted");
  },
};

export const RunnerMobileExpandedActivity: Story = {
  name: "Runner Activity / Mobile / Expanded Activity",
  render: () => <RunnerTurnStory items={mixedLiveActivity} mobile />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getAllByRole("button", { name: /expand activity/i })[0]!,
    );
    await expect(
      canvas.getByRole("list", { name: "Run activity" }),
    ).toBeInTheDocument();
    const avatarBottom = canvas
      .getByTestId("task-chat-agent-avatar")
      .getBoundingClientRect().bottom;
    const disclosureTop = canvas
      .getByTestId("task-chat-current-activity")
      .getBoundingClientRect().top;
    await expect(disclosureTop - avatarBottom).toBeGreaterThanOrEqual(4);
  },
};
