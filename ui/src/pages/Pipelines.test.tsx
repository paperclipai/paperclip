// @vitest-environment jsdom

import { useState } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type {
  PipelineAttentionCaseRef,
  PipelineAttentionFeed,
  PipelineBatchIngestResult,
  PipelineCaseDetail,
  PipelineDetail,
  PipelineIntakeField,
  PipelineListItem,
  PipelineReviewCaseRow,
} from "../api/pipelines";
import {
  buildBatchPayload,
  buildPipelineTableRows,
  buildReviewQueueRows,
  GeneratedField,
  isGuardedTransitionAllowed,
  PipelineItemDetailView,
  Pipelines,
  pipelineKeyFromName,
  PipelinesIndexTable,
  pipelinesHaveConnectionData,
  plainBatchError,
  resolvePipelineTargetStageId,
  ReviewQueue,
  validateDraftRows,
  type PipelineViewMode,
} from "./Pipelines";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockLocationPathname = vi.hoisted(() => ({ value: "/pipelines/pipeline-1/add" }));
const mockPipelinesApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getHealth: vi.fn(),
  getIntakeForm: vi.fn(),
  listCases: vi.fn(),
  getCase: vi.fn(),
  getCaseChildren: vi.fn(),
  getCaseEvents: vi.fn(),
  getCaseIssueLinks: vi.fn(),
  createIssueLink: vi.fn(),
  updateCase: vi.fn(),
  resolveSuggestion: vi.fn(),
  transitionCase: vi.fn(),
  rerunCurrentStageAutomation: vi.fn(),
  getAutomationRetryPlan: vi.fn(),
  retryStageAutomation: vi.fn(),
  ingestCasesBatch: vi.fn(),
  listAttention: vi.fn(),
  listReviewCases: vi.fn(),
  reviewCase: vi.fn(),
  bulkReviewCases: vi.fn(),
  listCompanyCaseEvents: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; state?: unknown; issuePrefetch?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: mockLocationPathname.value }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ pipelineId: "pipeline-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
  useOptionalCompany: () => ({ companies: [{ issuePrefix: "PAP" }] }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: { comments: unknown[] }) => {
    mockIssueChatThreadRender(props);
    return <div data-testid="issue-chat-thread">Embedded thread · {props.comments.length} comments</div>;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: (event: { preventDefault: () => void }) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.({ preventDefault: () => undefined })}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../api/pipelines", () => ({
  pipelinesApi: mockPipelinesApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

function mockElementScrollHeight(value: number) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  };
}

const fields: PipelineIntakeField[] = [
  { key: "title", label: "Name", type: "text", required: true },
  { key: "kind", label: "Type", type: "select", required: true, options: ["Blog post", "Launch tweet"] },
  { key: "notes", label: "Notes for the agent", type: "multiline", required: false },
];

describe("pipeline add-items helpers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders generated fields from the intake schema", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <div>
          {fields.map((field) => (
            <GeneratedField key={field.key} field={field} value="" onChange={() => undefined} />
          ))}
        </div>,
      );
    });

    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Type");
    expect(container.textContent).toContain("Notes for the agent");
    expect(container.querySelector("input")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("validates required fields from the intake schema", () => {
    const errors = validateDraftRows(
      [
        { id: "row-1", expanded: true, values: { title: "", kind: "" } },
        { id: "row-2", expanded: true, values: { title: "Launch blog post", kind: "Blog post" } },
      ],
      fields,
    );

    expect(errors["row-1"]).toEqual({
      title: "Name is required.",
      kind: "Type is required.",
    });
    expect(errors["row-2"]).toBeUndefined();
  });

  it("maps generated fields into the batch ingest payload", () => {
    const payload = buildBatchPayload(
      [
        {
          id: "row-1",
          expanded: true,
          values: {
            title: " Launch blog post ",
            kind: "Blog post",
            notes: " Keep it plain. ",
          },
        },
      ],
      fields,
    );

    expect(payload).toEqual([
      {
        title: "Launch blog post",
        fields: {
          kind: "Blog post",
          notes: "Keep it plain.",
        },
      },
    ]);
  });

  it("translates server row failures into plain language", () => {
    const result: PipelineBatchIngestResult = {
      ok: false,
      caseKey: null,
      error: {
        details: { code: "required_field", label: "Audience" },
      },
    };

    expect(plainBatchError(result)).toBe("Audience is required.");
  });
});

const pipeline: PipelineDetail = {
  id: "pipeline-1",
  companyId: "company-1",
  key: "content",
  name: "Content",
  description: null,
  projectId: null,
  enforceTransitions: false,
  archivedAt: null,
  stageCount: 3,
  openCaseCount: 1,
  createdAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:00:00.000Z",
  stages: [
    { id: "stage-intake", pipelineId: "pipeline-1", key: "intake", name: "Intake", kind: "working", position: 100, config: null },
    { id: "stage-review", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 200, config: null },
    { id: "stage-cancelled", pipelineId: "pipeline-1", key: "cancelled", name: "Removed", kind: "cancelled", position: 1000, config: null },
  ],
  transitions: [],
};

const linkedIssue = {
  id: "issue-1",
  companyId: "company-1",
  projectId: null,
  identifier: "PAP-1",
  title: "Discuss launch post",
  status: "todo",
};

function itemDetail(overrides: Record<string, unknown> = {}): PipelineCaseDetail {
  return {
    case: {
      id: "item-1",
      companyId: "company-1",
      pipelineId: "pipeline-1",
      stageId: "stage-intake",
      title: "Draft launch post",
      summary: "Prepare the announcement.",
      fields: { audience: "Operators" },
      version: 4,
      terminalKind: null,
      childCount: 1,
      terminalChildCount: 0,
      pendingSuggestion: {
        id: "suggestion-1",
        toStageKey: "review",
        rationale: "The draft is ready for review.",
        createdAt: "2026-06-10T12:00:00.000Z",
      },
      ...overrides,
    },
    stage: pipeline.stages[0],
    pipeline,
    allowedNextStages: pipeline.stages,
    links: [],
    blockers: [],
    blocks: [],
    childrenSummary: { childCount: 1, terminalChildCount: 0, loadedChildren: 1, descendantActiveWorkCount: 0 },
    activeWork: null,
    pendingSuggestion: null,
  };
}

async function renderItemPage(
  detail = itemDetail(),
  links: unknown[] = [],
  options: {
    children?: unknown;
    events?: unknown[];
    attachmentsByIssueId?: Record<string, unknown[]>;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  mockPipelinesApi.get.mockResolvedValue(pipeline);
  mockPipelinesApi.getCase.mockResolvedValue(detail);
  mockPipelinesApi.getCaseChildren.mockResolvedValue(options.children ?? [
    {
      case: {
        id: "child-1",
        pipelineId: "pipeline-1",
        stageId: "stage-review",
        title: "Child outline",
        fields: {},
        childCount: 2,
        terminalKind: null,
      },
      stage: pipeline.stages[1],
    },
  ]);
  mockPipelinesApi.getCaseEvents.mockResolvedValue({
    items: options.events ?? [
      {
        id: "event-1",
        companyId: "company-1",
        caseId: "item-1",
        type: "transition_suggested",
        actorType: "system",
        payload: { suggestion: { toStageKey: "review" } },
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
    ],
    pagination: { limit: 100, offset: 0, nextOffset: null, hasMore: false, order: "asc" },
  });
  mockPipelinesApi.getCaseIssueLinks.mockResolvedValue(links);
  mockPipelinesApi.getAutomationRetryPlan.mockImplementation((_caseId: string, scope: "current_stage" | "previous_stage") =>
    Promise.resolve({
      caseId: detail.case.id,
      scope,
      allowed: scope === "current_stage",
      caseVersion: detail.case.version ?? 1,
      currentStage: { id: detail.stage.id, key: detail.stage.key, name: detail.stage.name },
      targetStage: scope === "current_stage" ? { id: detail.stage.id, key: detail.stage.key, name: detail.stage.name } : null,
      automationId: scope === "current_stage" ? `${detail.stage.id}:on_enter` : null,
      routine: scope === "current_stage" ? { id: "routine-1", assigneeAgentId: "agent-1" } : null,
      previousAttemptId: null,
      generation: 1,
      effectCounts: {
        directChildren: 0,
        descendants: 0,
        linkedAutomationIssues: 0,
        activeDescendants: 0,
        unresolvedBlockers: 0,
      },
      defaultCleanup: {
        retireDirectChildren: false,
        retireDescendants: false,
        cancelLinkedAutomationIssues: false,
      },
      blockers: scope === "current_stage" ? [] : [{ kind: "previous_stage_not_found", message: "No previous step." }],
    }),
  );
  mockIssuesApi.listComments.mockResolvedValue([]);
  mockIssuesApi.listAttachments.mockImplementation((issueId: string) =>
    Promise.resolve(options.attachmentsByIssueId?.[issueId] ?? []),
  );

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PipelineItemDetailView pipelineId="pipeline-1" caseId="item-1" />
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return { container, root };
}

describe("PipelineItemDetailView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a pending suggestion, linked conversation, children, and activity", async () => {
    const { container, root } = await renderItemPage(itemDetail(), [
      {
        link: {
          id: "link-1",
          companyId: "company-1",
          caseId: "item-1",
          issueId: "issue-1",
          role: "conversation",
          createdAt: "2026-06-10T12:00:00.000Z",
          updatedAt: "2026-06-10T12:00:00.000Z",
        },
        issue: linkedIssue,
      },
    ]);

    expect(container.textContent).toContain("Draft launch post");
    expect(container.textContent).toContain("Ready to move to Review?");
    expect(container.textContent).toContain("Open conversation");
    expect(container.textContent).toContain("Child outline");
    expect(container.textContent).toContain("2 nested items hidden");
    expect(container.textContent).toContain("Suggested moving to Review.");
    const builtFromHeading = Array.from(container.querySelectorAll("aside h2"))
      .find((heading) => heading.textContent === "Built from 1 item");
    expect(builtFromHeading).not.toBeUndefined();
    expect(Array.from(container.querySelectorAll("main h2")).map((heading) => heading.textContent))
      .not.toContain("Built from 1 item");
    expect(mockIssueChatThreadRender).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      variant: "embedded",
    }));

    act(() => {
      root.unmount();
    });
  });

  it("uses the resolved conversation source issue for comments and composer actions", async () => {
    const sourceIssue = {
      ...linkedIssue,
      id: "producer-issue",
      identifier: "PAP-2",
      title: "Produce launch post",
      projectId: "project-1",
    } as Issue;
    const fallbackIssue = {
      ...linkedIssue,
      id: "fallback-work-issue",
      identifier: "PAP-3",
      title: "Fallback work item",
    };
    const detail = itemDetail();
    detail.conversationSource = {
      issue: sourceIssue,
      reason: "producer_update",
      linkRole: "automation",
      sourceRunId: "run-1",
    };
    mockIssuesApi.addComment.mockResolvedValue({ id: "comment-1" });

    const { container, root } = await renderItemPage(detail, [
      {
        link: {
          id: "link-work",
          companyId: "company-1",
          caseId: "item-1",
          issueId: "fallback-work-issue",
          role: "work",
          createdAt: "2026-06-10T12:00:00.000Z",
          updatedAt: "2026-06-10T12:00:00.000Z",
        },
        issue: fallbackIssue,
      },
    ], { children: [], events: [] });

    expect(container.textContent).toContain("Open conversation");
    expect(container.textContent).not.toContain("Start a conversation");
    expect(container.textContent).toContain("PAP-2: Produce launch post");
    expect(container.querySelector('a[href="/issues/PAP-2"]')).not.toBeNull();
    expect(mockIssuesApi.listComments).toHaveBeenCalledWith("producer-issue", { order: "asc", limit: 50 });

    const threadProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      issueId: string;
      companyId: string;
      projectId: string | null;
      issueStatus: string;
      onAdd: (body: string) => Promise<void>;
    };
    expect(threadProps).toMatchObject({
      issueId: "producer-issue",
      companyId: "company-1",
      projectId: "project-1",
      issueStatus: "todo",
    });

    await act(async () => {
      await threadProps.onAdd("Use the producer thread.");
    });
    expect(mockIssuesApi.addComment).toHaveBeenCalledWith("producer-issue", "Use the producer thread.");
    expect(mockIssuesApi.addComment).not.toHaveBeenCalledWith("fallback-work-issue", expect.any(String));

    act(() => {
      root.unmount();
    });
  });

  it("renders the item description as full markdown", async () => {
    const { container, root } = await renderItemPage(itemDetail({
      fields: {
        verified_event_types: "ingested,updated,automation_executed,transitioned,review_decided",
      },
      summary: [
        "### Acceptance",
        "",
        "- Render bullets",
        "- Keep uploaded images visible",
        "",
        "![](/api/assets/asset-1/content)",
      ].join("\n"),
    }), [], { children: [], events: [] });

    const markdown = container.querySelector(".paperclip-markdown");
    expect(markdown).not.toBeNull();
    expect(markdown?.closest("main")).not.toBeNull();
    expect(markdown?.closest("main")?.nextElementSibling?.tagName).toBe("ASIDE");
    expect(container.querySelector("h3")?.textContent).toBe("Acceptance");
    expect(Array.from(container.querySelectorAll("li")).map((item) => item.textContent)).toEqual([
      "Render bullets",
      "Keep uploaded images visible",
    ]);
    expect(container.querySelector('img[src="/api/assets/asset-1/content"]')).not.toBeNull();
    const sidebarValue = Array.from(container.querySelectorAll("dd"))
      .find((element) => element.textContent === "ingested,updated,automation_executed,transitioned,review_decided");
    expect(sidebarValue?.className).toContain("[overflow-wrap:anywhere]");

    act(() => {
      root.unmount();
    });
  });

  it("renders long dynamic item fields as markdown in the main pane instead of sidebar details", async () => {
    const { container, root } = await renderItemPage(itemDetail({
      fields: {
        audience: "Operators",
        reviewerOpenQuestions: [
          "### Reviewer open questions",
          "",
          "- Does this need a source?",
          "- Should we mention launch risk?",
        ].join("\n"),
      },
    }), [], { children: [], events: [] });

    const main = container.querySelector("main");
    const aside = container.querySelector("aside");
    expect(main?.textContent).toContain("Reviewer open questions");
    expect(main?.textContent).toContain("Does this need a source?");
    expect(main?.querySelector("h3")?.textContent).toBe("Reviewer open questions");
    expect(aside?.textContent).toContain("Audience");
    expect(aside?.textContent).toContain("Operators");
    expect(aside?.textContent).not.toContain("Reviewer open questions");
    expect(aside?.textContent).not.toContain("Does this need a source?");

    act(() => {
      root.unmount();
    });
  });

  it("shows image assets from linked issues below the item description", async () => {
    const { container, root } = await renderItemPage(itemDetail(), [
      {
        link: {
          id: "link-1",
          companyId: "company-1",
          caseId: "item-1",
          issueId: "issue-1",
          role: "work",
          createdAt: "2026-06-10T12:00:00.000Z",
          updatedAt: "2026-06-10T12:00:00.000Z",
        },
        issue: linkedIssue,
      },
    ], {
      children: [],
      events: [],
      attachmentsByIssueId: {
        "issue-1": [
          {
            id: "attachment-1",
            companyId: "company-1",
            issueId: "issue-1",
            issueCommentId: null,
            assetId: "asset-1",
            provider: "local_disk",
            objectKey: "att-1",
            contentType: "image/png",
            byteSize: 2048,
            sha256: "sha",
            originalFilename: "mockup.png",
            createdByAgentId: null,
            createdByUserId: "user-1",
            createdAt: "2026-06-10T12:00:00.000Z",
            updatedAt: "2026-06-10T12:00:00.000Z",
            contentPath: "/api/attachments/attachment-1/content",
          },
        ],
      },
    });

    expect(mockIssuesApi.listAttachments).toHaveBeenCalledWith("issue-1");
    const mainHeadings = Array.from(container.querySelectorAll("main h2")).map((heading) => heading.textContent);
    expect(mainHeadings).toEqual(["Linked assets", "Conversation"]);
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("1 asset");
    expect(container.querySelector('img[src="/api/attachments/attachment-1/content"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Download mockup.png"]')?.getAttribute("href")).toBe(
      "/api/attachments/attachment-1/content?download=1",
    );

    act(() => {
      root.unmount();
    });
  });

  it("folds long item markdown descriptions behind the shared show more fader", async () => {
    const restoreScrollHeight = mockElementScrollHeight(700);
    try {
      const { container, root } = await renderItemPage(itemDetail({
        summary: Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n"),
      }), [], { children: [], events: [] });

      const curtain = container.querySelector(".fold-curtain");
      const content = curtain?.querySelector(".fold-curtain__content");
      const toggle = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Show more"));

      expect(curtain).not.toBeNull();
      expect(content?.getAttribute("style")).toContain("max-height: 420px");
      expect(toggle).not.toBeUndefined();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        toggle!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(toggle?.textContent).toContain("Show less");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");

      act(() => {
        root.unmount();
      });
    } finally {
      restoreScrollHeight();
    }
  });

  it("shows the current stage and can re-run its entry automation", async () => {
    mockPipelinesApi.retryStageAutomation.mockResolvedValue({});
    const detail = itemDetail({
      stageId: "stage-review",
      pendingSuggestion: null,
      version: 7,
    });
    detail.stage = {
      ...pipeline.stages[1],
      name: "Content strategy",
      config: { onEnter: { type: "run_routine", routineId: "routine-1" } },
    };
    const { container, root } = await renderItemPage(detail, [], { children: [], events: [] });

    expect(container.textContent).toContain("Stage: Content strategy");
    expect(container.querySelector('button[aria-label="Stage actions"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Item actions"]')).not.toBeNull();
    const rerunButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Re-run this step"));
    expect(rerunButton).not.toBeNull();

    await act(async () => {
      rerunButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Review the automation preflight");

    let confirmButton: HTMLButtonElement | undefined;
    for (let attempt = 0; attempt < 10 && !confirmButton; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      confirmButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Re-run this step") && button !== rerunButton);
    }
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPipelinesApi.retryStageAutomation).toHaveBeenCalledWith("item-1", {
      scope: "current_stage",
      expectedVersion: 7,
      cleanup: {
        retireDirectChildren: false,
        retireDescendants: false,
        cancelLinkedAutomationIssues: false,
      },
    });
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Step automation re-run started", tone: "success" });

    act(() => {
      root.unmount();
    });
  });

  it("moves an item to another stage from the item actions menu", async () => {
    mockPipelinesApi.transitionCase.mockResolvedValue({});
    const detail = itemDetail({
      stageId: "stage-intake",
      pendingSuggestion: null,
      version: 4,
    });
    const { container, root } = await renderItemPage(detail, [], { children: [], events: [] });

    const moveMenuItem = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Move to stage"));
    expect(moveMenuItem).not.toBeNull();

    await act(async () => {
      moveMenuItem!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Manual moves can bypass the normal agent handoff");
    const confirmButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Move to Review");
    expect(confirmButton).not.toBeNull();

    await act(async () => {
      confirmButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPipelinesApi.transitionCase).toHaveBeenCalledWith("item-1", {
      toStageKey: "review",
      expectedVersion: 4,
      reason: "Manual board override from item page: moved from Intake to Review.",
      force: true,
    });
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Item moved", tone: "success" });

    act(() => {
      root.unmount();
    });
  });

  it("shows review decisions in the sidebar and advances to the next pipeline review item", async () => {
    const reviewStage = {
      ...pipeline.stages[1],
      config: {
        approveToStageKey: "done",
        rejectToStageKey: "cancelled",
        requestChangesToStageKey: "intake",
        requireRejectReason: true,
      },
    };
    const detail = itemDetail({
      stageId: "stage-review",
      pendingSuggestion: null,
      version: 7,
    });
    detail.stage = reviewStage;
    mockPipelinesApi.listReviewCases.mockResolvedValue([
      {
        case: detail.case,
        pipeline: { id: "pipeline-1", key: "content", name: "Content" },
        stage: reviewStage,
        parentCase: null,
        pendingSuggestion: null,
        reviewConfig: { approveToStageKey: "done", rejectToStageKey: "cancelled", requestChangesToStageKey: "intake", requireRejectReason: true },
      },
      {
        case: {
          id: "item-2",
          pipelineId: "pipeline-1",
          stageId: "stage-review",
          title: "Review the launch tweet",
          fields: {},
          version: 3,
          terminalKind: null,
        },
        pipeline: { id: "pipeline-1", key: "content", name: "Content" },
        stage: reviewStage,
        parentCase: null,
        pendingSuggestion: null,
        reviewConfig: { approveToStageKey: "done", rejectToStageKey: "cancelled", requestChangesToStageKey: "intake", requireRejectReason: true },
      },
    ]);
    mockPipelinesApi.reviewCase.mockResolvedValue({});

    const { container, root } = await renderItemPage(detail, [], { children: [], events: [] });

    expect(container.textContent).toContain("In review");
    expect(container.textContent).toContain("Next in this review queue: Review the launch tweet");
    const sidebarHeadings = Array.from(container.querySelectorAll("aside h2")).map((heading) => heading.textContent);
    expect(sidebarHeadings).toContain("Review");
    expect(Array.from(container.querySelectorAll("main h2")).map((heading) => heading.textContent))
      .toContain("Conversation");

    const approveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Approve and move to Done"]');
    expect(approveButton).not.toBeNull();

    await act(async () => {
      approveButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPipelinesApi.reviewCase).toHaveBeenCalledWith("item-1", {
      decision: "approve",
      reason: null,
      expectedVersion: 7,
    });
    expect(mockNavigate).toHaveBeenCalledWith("/pipelines/pipeline-1/items/item-2");

    act(() => {
      root.unmount();
    });
  });

  it("links each built-from child to its own pipeline, even across pipelines", async () => {
    const { container, root } = await renderItemPage(itemDetail(), [], {
      children: [
        {
          case: {
            id: "cross-child",
            // A release's feature children live in a different pipeline than the release.
            pipelineId: "pipeline-features",
            stageId: "stage-review",
            title: "Cross-pipeline feature",
            fields: {},
            childCount: 0,
            terminalKind: null,
          },
          stage: pipeline.stages[1],
        },
      ],
    });

    expect(container.textContent).toContain("Cross-pipeline feature");
    const link = container.querySelector('a[href="/pipelines/pipeline-features/items/cross-child"]');
    expect(link).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders waiting children as a compact vertical list with direct live work", async () => {
    const detail = itemDetail();
    detail.stage = {
      ...pipeline.stages[0],
      config: { requireChildrenTerminal: true },
    };
    detail.childrenSummary = { childCount: 2, terminalChildCount: 0, loadedChildren: 2, descendantActiveWorkCount: 2 };

    const { container, root } = await renderItemPage(detail, [], {
      children: [
        {
          case: {
            id: "child-live",
            pipelineId: "pipeline-1",
            stageId: "stage-intake",
            title: "Implement live indicator",
            fields: {},
            childCount: 1,
            terminalKind: null,
          },
          stage: pipeline.stages[0],
          activeWork: {
            issueId: "issue-live",
            issueIdentifier: "PAP-2",
            issueTitle: "Build the child",
            agentId: "agent-1",
            agentName: "CodexCoder",
            startedAt: "2026-06-16T10:00:00.000Z",
          },
          descendantActiveWorkCount: 1,
        },
        {
          case: {
            id: "child-quiet",
            pipelineId: "pipeline-1",
            stageId: "stage-review",
            title: "Review quiet child",
            fields: {},
            childCount: 0,
            terminalKind: null,
          },
          stage: pipeline.stages[1],
        },
      ],
      events: [],
    });

    const waitingSection = container.querySelector('section[aria-label="Waiting child items"]');
    expect(waitingSection).not.toBeNull();
    expect(waitingSection?.className).toContain("px-4");
    expect(waitingSection?.className).not.toContain("bg-muted");
    expect(waitingSection?.textContent).toContain("Waiting on 2 of 2 child items");
    expect(waitingSection?.textContent).toContain("Live with CodexCoder");
    expect(waitingSection?.textContent).toContain("1 live downstream");
    expect(waitingSection?.querySelectorAll("li")).toHaveLength(2);
    for (const rowLink of waitingSection?.querySelectorAll("li a") ?? []) {
      expect(rowLink.className).not.toContain("bg-muted");
    }

    act(() => {
      root.unmount();
    });
  });

  it("renders built-from children from the rollup tree response shape", async () => {
    const { container, root } = await renderItemPage(itemDetail(), [], {
      children: {
        case: {
          id: "item-1",
          title: "Release v0.42",
          pipeline: { id: "pipeline-1", key: "release", name: "Release" },
          stage: { id: "stage-intake", key: "intake", name: "Intake", kind: "working" },
          childGroups: [
            {
              pipeline: { id: "pipeline-features", key: "feature", name: "Feature Content" },
              cases: [
                {
                  id: "feature-1",
                  caseKey: "v0.42-pipelines-ui",
                  title: "Feature: Pipelines UI",
                  terminalKind: "done",
                  pipeline: { id: "pipeline-features", key: "feature", name: "Feature Content" },
                  stage: { id: "feature-covered", key: "covered", name: "Covered", kind: "done" },
                  rollup: { total: 6, done: 3, dropped: 3, inMotion: 0 },
                  childGroups: [],
                },
              ],
            },
          ],
        },
      },
    });

    expect(container.textContent).toContain("Feature: Pipelines UI");
    expect(container.textContent).toContain("6 nested items hidden");
    const link = container.querySelector('a[href="/pipelines/pipeline-features/items/feature-1"]');
    expect(link).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("shows the active automation issue near the top of the item page", async () => {
    const detail = itemDetail();
    detail.activeWork = {
      issueId: "issue-automation",
      issueIdentifier: "PAP-11218",
      issueTitle: "Run item automation",
      issueRole: "automation",
      agentId: "agent-1",
      agentName: "CodexCoder",
      startedAt: "2026-06-16T10:00:00.000Z",
    };

    const { container, root } = await renderItemPage(detail, [], { children: [], events: [] });

    expect(container.textContent).toContain("Automation is running");
    expect(container.textContent).toContain("PAP-11218");
    expect(container.textContent).toContain("is active with CodexCoder");
    expect(container.querySelector('a[href="/issues/PAP-11218"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders empty states when there is no suggestion, conversation, or child item", async () => {
    const emptyDetail = itemDetail({
      fields: {},
      summary: null,
      childCount: 0,
      pendingSuggestion: null,
    });
    emptyDetail.childrenSummary = { childCount: 0, terminalChildCount: 0, loadedChildren: 0, descendantActiveWorkCount: 0 };
    const { container, root } = await renderItemPage(emptyDetail, [], { children: [], events: [] });

    expect(container.textContent).not.toContain("Ready to move");
    expect(container.textContent).toContain("Start a conversation");
    expect(container.textContent).toContain("No active conversation yet.");
    expect(container.textContent).toContain("No built-from items.");

    act(() => {
      root.unmount();
    });
  });
});

function makeListPipeline(overrides: Partial<PipelineListItem> & { id: string; name: string }): PipelineListItem {
  return {
    companyId: "company-1",
    key: overrides.id,
    description: null,
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 3,
    openCaseCount: 0,
    attentionCount: 0,
    inMotionCount: 0,
    lastActivityAt: null,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    ...overrides,
  };
}

function connectedPipelines(): PipelineListItem[] {
  return [
    makeListPipeline({
      id: "release",
      name: "Release",
      description: "the launch this work is building toward",
      openCaseCount: 1,
      connections: { upstreamPipelineIds: [], downstreamPipelineIds: ["features"] },
    }),
    makeListPipeline({
      id: "features",
      name: "Features",
      attentionCount: 1,
      openCaseCount: 4,
      connections: { upstreamPipelineIds: ["release"], downstreamPipelineIds: ["content"] },
    }),
    makeListPipeline({
      id: "content",
      name: "Content production",
      attentionCount: 2,
      inMotionCount: 3,
      openCaseCount: 7,
      connections: { upstreamPipelineIds: ["features"], downstreamPipelineIds: [] },
    }),
  ];
}

function renderIndexTable({
  pipelines,
  connectionsAvailable,
  search = "",
}: {
  pipelines: PipelineListItem[];
  connectionsAvailable: boolean;
  search?: string;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [viewMode, setViewMode] = useState<PipelineViewMode>("nested");
    const [query, setQuery] = useState(search);

    return (
      <PipelinesIndexTable
        pipelines={pipelines}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        connectionsAvailable={connectionsAvailable}
        search={query}
        onSearchChange={setQuery}
      />
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

describe("PipelinesIndexTable", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("nests connected pipelines under their upstream work", () => {
    const { container, root } = renderIndexTable({
      pipelines: connectedPipelines(),
      connectionsAvailable: true,
    });

    const content = container.textContent ?? "";
    expect(content.indexOf("Release")).toBeLessThan(content.indexOf("Features"));
    expect(content.indexOf("Features")).toBeLessThan(content.indexOf("Content production"));
    expect(content).toContain("under Release");
    expect(content).toContain("under Features");

    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Release"]');
    expect(collapse).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("switches between nested and flat views when connection data exists", () => {
    const { container, root } = renderIndexTable({
      pipelines: connectedPipelines(),
      connectionsAvailable: true,
    });

    expect(container.textContent).toContain("under Release");

    const flatButton = container.querySelector<HTMLButtonElement>('button[title="Flat list"]');
    expect(flatButton).toBeTruthy();

    act(() => {
      flatButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("under Release");
    expect(container.textContent).not.toContain("under Features");

    act(() => {
      root.unmount();
    });
  });

  it("disables the nested toggle until connection data exists", () => {
    const noConnections = [
      makeListPipeline({ id: "support", name: "Support knowledge base" }),
      makeListPipeline({ id: "sales", name: "Sales decks" }),
    ].map((pipeline) => {
      const { connections: _connections, ...rest } = pipeline;
      return rest as PipelineListItem;
    });
    expect(pipelinesHaveConnectionData(noConnections)).toBe(false);

    const { container, root } = renderIndexTable({
      pipelines: noConnections,
      connectionsAvailable: false,
    });

    const nestedButton = container.querySelector<HTMLButtonElement>('button[title="Nested view"]');
    expect(nestedButton?.disabled).toBe(true);
    expect(container.textContent).toContain("Support knowledge base");
    expect(container.textContent).toContain("Sales decks");

    act(() => {
      root.unmount();
    });
  });

  it("renders attention and in-motion copy only when nonzero", () => {
    const { container, root } = renderIndexTable({
      pipelines: [
        makeListPipeline({
          id: "hiring",
          name: "Hiring pipeline",
          attentionCount: 3,
          inMotionCount: 2,
          openCaseCount: 18,
        }),
        makeListPipeline({
          id: "recap",
          name: "Quarterly board recap",
          archivedAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
      connectionsAvailable: false,
    });

    const content = container.textContent ?? "";
    expect(content).toContain("3 to review");
    expect(content).toContain("2 in motion");
    expect(content).toContain("18 open");
    expect(content).toContain("Paused");
    expect(content).not.toContain("0 to review");
    expect(content).not.toContain("0 in motion");

    act(() => {
      root.unmount();
    });
  });

  it("shows live downstream copy when descendants are actively running", () => {
    const { container, root } = renderIndexTable({
      pipelines: [
        makeListPipeline({
          id: "release",
          name: "Release pipeline",
          descendantActiveWorkCount: 4,
        }),
      ],
      connectionsAvailable: false,
    });

    expect(container.textContent).toContain("4 live downstream");

    act(() => {
      root.unmount();
    });
  });

  it("shows an empty state when search filters out every pipeline", () => {
    const { container, root } = renderIndexTable({
      pipelines: [makeListPipeline({ id: "press", name: "Press outreach" })],
      connectionsAvailable: false,
      search: "customer",
    });

    expect(container.textContent).toContain("No pipelines match your search.");

    act(() => {
      root.unmount();
    });
  });
});

describe("pipeline index helpers", () => {
  it("keeps collapsed branches out of the row list", () => {
    const rows = buildPipelineTableRows(connectedPipelines(), {
      viewMode: "nested",
      collapsedPipelineIds: new Set(["features"]),
    });

    expect(rows.map((row) => row.pipeline.id)).toEqual(["release", "features"]);
    expect(rows[1]?.expanded).toBe(false);
  });

  it("derives a url-safe key from the pipeline name", () => {
    expect(pipelineKeyFromName("Content production!")).toBe("content-production");
    expect(pipelineKeyFromName("   ")).toBe("pipeline");
  });
});

describe("pipeline board guard helpers", () => {
  const transitions = [
    { fromStageId: "stage-a", toStageId: "stage-b" },
    { fromStageId: "stage-b", toStageId: "stage-c" },
  ];

  it("allows configured moves and blocks skipped ones", () => {
    expect(isGuardedTransitionAllowed(transitions, "stage-a", "stage-b")).toBe(true);
    expect(isGuardedTransitionAllowed(transitions, "stage-a", "stage-c")).toBe(false);
    expect(isGuardedTransitionAllowed(transitions, "stage-a", "stage-a")).toBe(true);
    expect(isGuardedTransitionAllowed([], "stage-a", "stage-c")).toBe(true);
    expect(isGuardedTransitionAllowed(transitions, null, "stage-b")).toBe(false);
  });

  it("resolves drop targets from columns or sibling items", () => {
    const columns = new Set(["stage-a", "stage-b"]);
    const caseToColumn = new Map([["item-1", "stage-b"]]);

    expect(resolvePipelineTargetStageId("stage-a", columns, caseToColumn)).toBe("stage-a");
    expect(resolvePipelineTargetStageId("item-1", columns, caseToColumn)).toBe("stage-b");
    expect(resolvePipelineTargetStageId("missing", columns, caseToColumn)).toBeNull();
  });
});

async function renderPipelineBoard(options: {
  cases?: unknown[];
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  mockLocationPathname.value = "/pipelines/pipeline-1";
  mockPipelinesApi.get.mockResolvedValue(pipeline);
  mockPipelinesApi.listCases.mockResolvedValue(options.cases ?? [
    {
      case: {
        id: "item-1",
        companyId: "company-1",
        pipelineId: "pipeline-1",
        stageId: "stage-intake",
        title: "Draft launch post",
        fields: {},
        terminalKind: null,
      },
      activeWork: null,
      descendantActiveWorkCount: 0,
    },
  ]);
  mockPipelinesApi.getHealth.mockResolvedValue({
    pipelineId: "pipeline-1",
    ok: false,
    warnings: [
      {
        code: "stage_no_automation",
        stageId: "stage-intake",
        stageKey: "intake",
        stageName: "Intake",
        message:
          "Nothing runs here automatically — items will sit until a person moves them. Add an agent to run this step, or make it a review step if a person should decide.",
      },
    ],
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Pipelines />
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return { container, root, queryClient };
}

describe("PipelineBoard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mockLocationPathname.value = "/pipelines/pipeline-1/add";
    vi.clearAllMocks();
  });

  it("shows rolled-up health warning counts in stage column headers", async () => {
    const { container, root, queryClient } = await renderPipelineBoard();

    expect(container.textContent).toContain("Some steps won't run yet");
    expect(container.textContent).toContain("1 warning");
    expect(container.textContent).toContain("1 item");

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("links stage headers to settings with that stage selected", async () => {
    const { container, root, queryClient } = await renderPipelineBoard();

    const editStageLink = container.querySelector<HTMLAnchorElement>('a[aria-label="Edit Intake stage"]');
    expect(editStageLink?.getAttribute("href")).toBe("/pipelines/pipeline-1/settings?stage=stage-intake");
    expect(editStageLink?.className).toContain("group-hover/stage-header:opacity-100");

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("shows live downstream copy on pipeline cards", async () => {
    const { container, root, queryClient } = await renderPipelineBoard({
      cases: [
        {
          case: {
            id: "item-live-descendants",
            companyId: "company-1",
            pipelineId: "pipeline-1",
            stageId: "stage-intake",
            title: "Release train",
            fields: {},
            terminalKind: null,
          },
          activeWork: null,
          descendantActiveWorkCount: 3,
        },
      ],
    });

    expect(container.textContent).toContain("Release train");
    expect(container.textContent).toContain("3 live downstream");

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});

function attentionCase(
  overrides: Partial<PipelineAttentionCaseRef> & { id: string; title: string },
): PipelineAttentionCaseRef {
  return {
    caseKey: overrides.id.toUpperCase(),
    summary: null,
    version: 1,
    terminalKind: null,
    parentCaseId: null,
    updatedAt: "2026-06-10T10:00:00.000Z",
    createdAt: "2026-06-10T08:00:00.000Z",
    pipeline: { id: "pipeline-1", key: "content", name: "Content production" },
    stage: { id: "stage-review", key: "review", name: "Review", kind: "review" },
    ...overrides,
  };
}

function attentionFeed(overrides: Partial<PipelineAttentionFeed> = {}): PipelineAttentionFeed {
  const feed: PipelineAttentionFeed = {
    suggestions: [],
    reviews: [],
    headsUp: [],
    counts: { suggestions: 0, reviews: 0, headsUp: 0 },
    ...overrides,
  };
  feed.counts = {
    suggestions: feed.suggestions.length,
    reviews: feed.reviews.length,
    headsUp: feed.headsUp.length,
  };
  return feed;
}

const triageFeed = attentionFeed({
  suggestions: [
    {
      case: attentionCase({
        id: "suggestion-1",
        title: "Draft launch post",
        stage: { id: "stage-drafting", key: "drafting", name: "Drafting", kind: "working" },
        version: 2,
      }),
      suggestion: {
        id: "sg-1",
        fromStageKey: "drafting",
        fromStageName: "Drafting",
        toStageKey: "review",
        toStageName: "Review",
        rationale: "Drafting agent thinks Draft launch post is ready to move forward.",
        confidence: null,
        createdAt: "2026-06-10T11:00:00.000Z",
        suggestedBy: { agentId: "agent-1", agentName: "Drafting agent" },
      },
    },
  ],
  reviews: [
    {
      case: attentionCase({
        id: "review-1",
        title: "Final launch post",
        version: 3,
        updatedAt: "2026-06-10T10:00:00.000Z",
      }),
      review: {
        expectedVersion: 3,
        approveToStageKey: "done",
        rejectToStageKey: null,
        requestChangesToStageKey: "drafting",
        requireRejectReason: true,
        reviewerKind: "human",
      },
    },
  ],
  headsUp: [
    {
      case: attentionCase({
        id: "heads-up-1",
        title: "Launch tweet",
        stage: { id: "stage-drafting", key: "drafting", name: "Drafting", kind: "working" },
      }),
      drift: {
        eventId: "event-1",
        createdAt: "2026-06-10T09:00:00.000Z",
        previousVersion: 1,
        version: 2,
        upstream: {
          caseId: "upstream-1",
          caseKey: "FEAT-1",
          title: "Launch plan",
          pipelineId: "pipeline-2",
          pipelineName: "Features",
        },
      },
      activeWork: null,
      workIssue: null,
    },
  ],
});

describe("buildReviewQueueRows", () => {
  it("groups attention rows into the daily triage sections", () => {
    const rows = buildReviewQueueRows({ attention: triageFeed, reviewCases: [] });

    expect(rows.map((row) => row.kind)).toEqual(["suggestion", "review", "headsUp"]);
    expect(rows.find((row) => row.kind === "review")?.pipelineName).toBe("Content production");
    expect(rows.find((row) => row.kind === "review")?.expectedVersion).toBe(3);
    expect(rows.find((row) => row.kind === "suggestion")?.suggestionId).toBe("sg-1");
    expect(rows.map((row) => row.prompt).join(" ")).not.toMatch(/\bcase\b/i);
  });

  it("merges review-stage details and skips duplicate suggestion rows", () => {
    const reviewCaseRow = {
      case: {
        id: "review-1",
        pipelineId: "pipeline-1",
        stageId: "stage-review",
        title: "Final launch post",
        fields: { audience: "Operators" },
        version: 3,
        updatedAt: "2026-06-10T10:00:00.000Z",
        createdAt: "2026-06-10T08:00:00.000Z",
        pendingSuggestion: {
          id: "sg-review",
          toStageKey: "done",
          rationale: "Ready to publish.",
          createdAt: "2026-06-10T09:30:00.000Z",
        },
      },
      pipeline: { id: "pipeline-1", key: "content", name: "Content production" },
      stage: { id: "stage-review", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 200 },
      parentCase: null,
      pendingSuggestion: null,
      reviewConfig: { requireRejectReason: true },
    } as unknown as PipelineReviewCaseRow;

    const duplicateSuggestionFeed = attentionFeed({
      suggestions: [
        {
          case: attentionCase({ id: "review-1", title: "Final launch post", version: 3 }),
          suggestion: {
            id: "sg-review",
            fromStageKey: "review",
            fromStageName: "Review",
            toStageKey: "done",
            toStageName: "Done",
            rationale: "Ready to publish.",
            confidence: null,
            createdAt: "2026-06-10T09:30:00.000Z",
            suggestedBy: null,
          },
        },
      ],
      reviews: triageFeed.reviews,
    });

    const rows = buildReviewQueueRows({
      attention: duplicateSuggestionFeed,
      reviewCases: [reviewCaseRow],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("review");
    expect(rows[0].fields).toEqual({ audience: "Operators" });
  });
});

async function renderReviewQueue() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ReviewQueue />
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return { container, root, queryClient };
}

describe("ReviewQueue", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("approves a final-review row through the review endpoint", async () => {
    mockPipelinesApi.listAttention.mockResolvedValue(attentionFeed({ reviews: triageFeed.reviews }));
    mockPipelinesApi.listReviewCases.mockResolvedValue([]);
    mockPipelinesApi.reviewCase.mockResolvedValue({});

    const { container, root } = await renderReviewQueue();

    expect(container.textContent).toContain("Final calls");
    expect(container.textContent).toContain("Final launch post");
    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve",
    );
    expect(approveButton).toBeTruthy();

    await act(async () => {
      approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPipelinesApi.reviewCase).toHaveBeenCalledWith("review-1", {
      decision: "approve",
      reason: null,
      expectedVersion: 3,
    });

    act(() => {
      root.unmount();
    });
  });

  it("accepts a suggestion row through the resolve-suggestion endpoint", async () => {
    mockPipelinesApi.listAttention.mockResolvedValue(attentionFeed({ suggestions: triageFeed.suggestions }));
    mockPipelinesApi.listReviewCases.mockResolvedValue([]);
    mockPipelinesApi.resolveSuggestion.mockResolvedValue({});

    const { container, root } = await renderReviewQueue();

    expect(container.textContent).toContain("Suggestions to review");
    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve",
    );
    expect(approveButton).toBeTruthy();

    await act(async () => {
      approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPipelinesApi.resolveSuggestion).toHaveBeenCalledWith("suggestion-1", {
      suggestionId: "sg-1",
      resolution: "accept",
      expectedVersion: 2,
      reason: null,
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows the empty state when nothing needs attention", async () => {
    mockPipelinesApi.listAttention.mockResolvedValue(attentionFeed());
    mockPipelinesApi.listReviewCases.mockResolvedValue([]);

    const { container, root } = await renderReviewQueue();

    expect(container.textContent).toContain("Nothing needs you right now.");

    act(() => {
      root.unmount();
    });
  });
});
