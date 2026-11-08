// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  StrictMode,
  useImperativeHandle,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";
import { loadDraft, saveDraft, saveDraftSubmission, loadDraftSubmission, preserveDraftInTab, settleDraftSubmission } from "../lib/composer-draft";
import { queryKeys } from "../lib/queryKeys";
import { useAccountBoundMutation } from "../hooks/useAccountBoundMutation";
import {
  IssueAssigneePausedNotice,
  IssueChatThread,
  VIRTUALIZED_THREAD_ROW_THRESHOLD,
  canStopIssueChatRun,
  findLatestCommentMessageIndex,
  getVirtualizedMeasurementScrollAdjustment,
  resolveAssistantMessageFoldedState,
  resolveIssueChatHumanAuthor,
} from "./IssueChatThread";
import type {
  AskUserQuestionsInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import {
  issueChatLongThreadAgentMap,
  issueChatLongThreadComments,
  issueChatLongThreadEvents,
  issueChatLongThreadLinkedRuns,
  issueChatLongThreadTranscriptsByRunId,
} from "../fixtures/issueChatLongThreadFixture";
import { expiredSecretProposalInteraction } from "../fixtures/issueThreadInteractionFixtures";
import type {
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";

function flushAct<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

function hasSmoothScrollBehavior(arg: unknown) {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "behavior" in arg &&
    (arg as ScrollToOptions).behavior === "smooth"
  );
}

const { markdownBodyRenderMock, markdownEditorFocusMock } = vi.hoisted(() => ({
  markdownBodyRenderMock: vi.fn(),
  markdownEditorFocusMock: vi.fn(),
}));

const { appendMock } = vi.hoisted(() => ({
  appendMock: vi.fn(async () => undefined),
}));

const {
  captureComposerViewportSnapshotMock,
  restoreComposerViewportSnapshotMock,
  shouldPreserveComposerViewportMock,
} = vi.hoisted(() => ({
  captureComposerViewportSnapshotMock: vi.fn(),
  restoreComposerViewportSnapshotMock: vi.fn(),
  shouldPreserveComposerViewportMock: vi.fn(),
}));

// The session lookup never answers on its own; tests set the account directly.
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: () => new Promise(() => {}) } };
});

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  useAui: () => ({ thread: () => ({ append: appendMock }) }),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("../lib/issue-chat-scroll", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/issue-chat-scroll")>();
  return {
    ...actual,
    captureComposerViewportSnapshot:
      captureComposerViewportSnapshotMock.mockImplementation(
        actual.captureComposerViewportSnapshot,
      ),
    restoreComposerViewportSnapshot:
      restoreComposerViewportSnapshotMock.mockImplementation(
        actual.restoreComposerViewportSnapshot,
      ),
    shouldPreserveComposerViewport:
      shouldPreserveComposerViewportMock.mockImplementation(
        actual.shouldPreserveComposerViewport,
      ),
  };
});

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => {
    markdownBodyRenderMock({ children, className });
    return <div className={className}>{children}</div>;
  },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(
    (
      {
        value = "",
        onChange,
        placeholder,
        className,
        contentClassName,
        fileDropTarget,
      }: {
        value?: string;
        onChange?: (value: string) => void;
        placeholder?: string;
        className?: string;
        contentClassName?: string;
        fileDropTarget?: "editor" | "parent";
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({
        focus: markdownEditorFocusMock,
      }));

      return (
        <textarea
          aria-label="Issue chat editor"
          data-class-name={className}
          data-content-class-name={contentClassName}
          data-file-drop-target={fileDropTarget}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    },
  ),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <select aria-label="Test recipient" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="agent:first">First agent</option>
      <option value="agent:latest">Latest agent</option>
      <option value="user:me">Me</option>
      <option value="">No responsible</option>
    </select>
  ),
}));

vi.mock("./Identity", async importOriginal => ({
  ...await importOriginal<typeof import("./Identity")>(),
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./OutputFeedbackButtons", () => ({
  OutputFeedbackButtons: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({
    children,
    to,
    issuePathId,
    className,
  }: {
    children: ReactNode;
    to: string;
    issuePathId: string;
    className?: string;
  }) => (
    <a href={to} data-issue-path-id={issuePathId} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createSuggestedTasksInteraction(
  overrides: Partial<SuggestTasksInteraction> = {},
): SuggestTasksInteraction {
  return {
    id: "interaction-suggest-1",
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
    resolverPolicy: overrides.resolverPolicy ?? "anyone",
    requestedResolverPolicy: overrides.requestedResolverPolicy ?? "anyone",
    effectiveResolverPolicy: overrides.effectiveResolverPolicy ?? "anyone",
    resolverPolicyProvenance: overrides.resolverPolicyProvenance ?? "inherited",
    effectiveResolverPolicySource:
      overrides.effectiveResolverPolicySource ?? "requested",
    legacyResolverPolicyAliases: overrides.legacyResolverPolicyAliases ?? {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
  };
}

function createQuestionInteraction(
  overrides: Partial<AskUserQuestionsInteraction> = {},
): AskUserQuestionsInteraction {
  return {
    id: "interaction-question-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "ask_user_questions",
    title: "Clarify the phase",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:03:00.000Z"),
    updatedAt: new Date("2026-04-06T12:03:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      submitLabel: "Submit answers",
      questions: [
        {
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [
            { id: "phase-1", label: "Phase 1" },
            { id: "phase-2", label: "Phase 2" },
          ],
        },
      ],
    },
    result: null,
    ...overrides,
    resolverPolicy: overrides.resolverPolicy ?? "anyone",
    requestedResolverPolicy: overrides.requestedResolverPolicy ?? "anyone",
    effectiveResolverPolicy: overrides.effectiveResolverPolicy ?? "anyone",
    resolverPolicyProvenance: overrides.resolverPolicyProvenance ?? "inherited",
    effectiveResolverPolicySource:
      overrides.effectiveResolverPolicySource ?? "requested",
    legacyResolverPolicyAliases: overrides.legacyResolverPolicyAliases ?? {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
  };
}

function createExpiredRequestConfirmationInteraction(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "interaction-confirmation-expired",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    status: "expired",
    continuationPolicy: "wake_assignee_on_accept",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: "user-1",
    createdAt: new Date("2026-04-06T12:04:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    resolvedAt: new Date("2026-04-06T12:05:00.000Z"),
    payload: {
      version: 1,
      prompt: "Approve the plan and let the responsible start implementation?",
      acceptLabel: "Approve plan",
      rejectLabel: "Request revisions",
    },
    result: {
      version: 1,
      outcome: "superseded_by_comment",
      commentId: "comment-1",
    },
    ...overrides,
    resolverPolicy: overrides.resolverPolicy ?? "anyone",
    requestedResolverPolicy: overrides.requestedResolverPolicy ?? "anyone",
    effectiveResolverPolicy: overrides.effectiveResolverPolicy ?? "anyone",
    resolverPolicyProvenance: overrides.resolverPolicyProvenance ?? "inherited",
    effectiveResolverPolicySource:
      overrides.effectiveResolverPolicySource ?? "requested",
    legacyResolverPolicyAliases: overrides.legacyResolverPolicyAliases ?? {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
  };
}

function createFileDragEvent(type: string, files: File[]) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as Event & {
    dataTransfer: {
      types: string[];
      files: File[];
      dropEffect?: string;
    };
  };
  event.dataTransfer = {
    types: ["Files"],
    files,
  };
  return event;
}


import { i18n } from "@/i18n";
it.each(["missing", "manual", "unsupported"])("close-boundary attachment %s stays locale-reactive without replay", async scenario => {
  await i18n.changeLanguage("en");
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const upload = vi.fn(scenario === "manual" ? async () => { throw new Error("Upload did not return a file URL"); } : async () => undefined);
  const add = vi.fn();
  await act(async () => root.render(<MemoryRouter><IssueChatThread comments={[]} linkedRuns={[]} timelineEvents={[]} liveRuns={[]} onAdd={add} enableLiveTranscriptPolling={false}
    {...(scenario === "unsupported" ? { imageUploadHandler: async () => "/raw/image" } : { onAttachImage: upload })} /></MemoryRouter>));
  const composer = container.querySelector('[data-testid="issue-chat-composer"]')!;
  const file = new File(["raw"], "raw-file.txt", { type: "text/plain" });
  try {
    await act(async () => composer.dispatchEvent(createFileDragEvent("drop", [file])));
    expect(container.textContent).toContain(scenario === "unsupported" ? "This file type cannot be attached here" : "Upload did not return a file URL");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain(scenario === "unsupported" ? "此处无法附加该类型的文件" : scenario === "manual" ? "Upload did not return a file URL" : "上传未返回文件 URL");
    expect(container.textContent).toContain("raw-file.txt"); expect(upload).toHaveBeenCalledTimes(scenario === "unsupported" ? 0 : 1); expect(add).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain(scenario === "unsupported" ? "This file type cannot be attached here" : "Upload did not return a file URL");
    expect(upload).toHaveBeenCalledTimes(scenario === "unsupported" ? 0 : 1);
  } finally { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage("en"); }
});
