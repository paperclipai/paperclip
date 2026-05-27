// @vitest-environment jsdom

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DocumentAnnotationThreadWithComments,
  IssueDocument,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentAnnotationsCountChip,
  IssueDocumentAnnotations,
} from "./IssueDocumentAnnotations";

const mockAnnotationsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  updateStatus: vi.fn(),
}));

const mockPendingAnchor = vi.hoisted(() => ({
  selector: {
    quote: { exact: "should keep the editor", prefix: "We ", suffix: "." },
    position: { normalizedStart: 10, normalizedEnd: 32, markdownStart: 10, markdownEnd: 32 },
  },
  selectedText: "should keep the editor",
}));

vi.mock("@/api/document-annotations", () => ({
  documentAnnotationsApi: mockAnnotationsApi,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-slot="sheet">{children}</div> : null,
  SheetContent: ({
    children,
    className,
    side,
  }: {
    children: React.ReactNode;
    className?: string;
    side?: string;
  }) => (
    <div data-slot="sheet-content" data-side={side} className={className}>
      {children}
    </div>
  ),
  SheetTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="sheet-title" className={className}>{children}</div>
  ),
}));

vi.mock("./DocumentAnnotationLayer", () => ({
  DocumentAnnotationLayer: (props: {
    newCommentDisabled?: boolean;
    onPendingAnchorChange: (anchor: typeof mockPendingAnchor | null) => void;
    onRequestComment: (anchor: typeof mockPendingAnchor) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="mock-annotation-selection"
        disabled={props.newCommentDisabled}
        onClick={() => {
          props.onPendingAnchorChange(mockPendingAnchor);
          props.onRequestComment(mockPendingAnchor);
          props.onPendingAnchorChange(null);
        }}
      >
        Mock selection
      </button>
      <button
        type="button"
        data-testid="mock-annotation-selection-only"
        disabled={props.newCommentDisabled}
        onClick={() => {
          props.onPendingAnchorChange(mockPendingAnchor);
        }}
      >
        Mock captured selection
      </button>
    </>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flush() {
  await act(() => {});
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeDoc(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "doc-1",
    companyId: "co-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Plan\n\nWe should keep the editor.",
    latestRevisionId: "rev-4",
    latestRevisionNumber: 4,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:01:00Z"),
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<DocumentAnnotationThreadWithComments> = {},
): DocumentAnnotationThreadWithComments {
  const id = overrides.id ?? "thread-1";
  return {
    id,
    companyId: "co-1",
    issueId: "issue-1",
    documentId: "doc-1",
    documentKey: "plan",
    status: "open",
    anchorState: "active",
    anchorConfidence: "exact",
    originalRevisionId: "rev-4",
    originalRevisionNumber: 4,
    currentRevisionId: "rev-4",
    currentRevisionNumber: 4,
    selectedText: "should keep the editor",
    prefixText: "We ",
    suffixText: ".",
    normalizedStart: 0,
    normalizedEnd: 22,
    markdownStart: 0,
    markdownEnd: 22,
    anchorSelector: {
      quote: { exact: "should keep the editor", prefix: "We ", suffix: "." },
      position: { normalizedStart: 0, normalizedEnd: 22, markdownStart: 0, markdownEnd: 22 },
    },
    createdByAgentId: null,
    createdByUserId: "user-1",
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-04-01T00:01:00Z"),
    updatedAt: new Date("2026-04-01T00:02:00Z"),
    comments: [
      {
        id: "comment-1",
        companyId: "co-1",
        threadId: id,
        issueId: "issue-1",
        documentId: "doc-1",
        body: "Please clarify this assumption.",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        createdAt: new Date("2026-04-01T00:01:00Z"),
        updatedAt: new Date("2026-04-01T00:01:00Z"),
      },
    ],
    ...overrides,
  };
}

function Harness({
  doc,
  draftDirty = false,
  draftConflicted = false,
  historicalPreview = false,
  locationHash = "",
  initialPanelOpen = false,
}: {
  doc: IssueDocument;
  draftDirty?: boolean;
  draftConflicted?: boolean;
  historicalPreview?: boolean;
  locationHash?: string;
  initialPanelOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialPanelOpen);
  return (
    <>
      <DocumentAnnotationsCountChip
        issueId="issue-1"
        docKey={doc.key}
        panelOpen={open}
        onToggle={() => setOpen((current) => !current)}
      />
      <IssueDocumentAnnotations
        issueId="issue-1"
        doc={doc}
        bodyMarkdown={doc.body}
        draftDirty={draftDirty}
        draftConflicted={draftConflicted}
        historicalPreview={historicalPreview}
        locationHash={locationHash}
        panelOpen={open}
        onPanelOpenChange={setOpen}
      >
        <p>Body content</p>
      </IssueDocumentAnnotations>
    </>
  );
}

describe("IssueDocumentAnnotations", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the open count chip and opens the panel on click", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const chip = container.querySelector('[data-testid="document-annotation-count-plan"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("1");
    expect(mockAnnotationsApi.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      (chip as HTMLButtonElement).click();
    });
    await flush();
    const panel = container.querySelector('[data-testid="document-annotation-panel"]');
    expect(panel).not.toBeNull();
    const anchor = container.querySelector('[data-testid="document-annotation-panel-anchor"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.className).toContain("fixed");
  });

  it("keeps the desktop annotation panel inside the issue content area when properties are visible", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectFor = (left: number, top: number, right: number, bottom: number) => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this instanceof HTMLElement && this.id === "main-content") {
        return rectFor(0, 0, 900, 800);
      }
      if (
        this instanceof HTMLElement
        && this.getAttribute("data-testid") === "document-annotation-body-plan"
      ) {
        return rectFor(80, 120, 640, 620);
      }
      return originalGetBoundingClientRect.call(this);
    });

    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <main id="main-content">
              <Harness doc={doc} initialPanelOpen />
            </main>
          </QueryClientProvider>,
        );
      });
      await flush();
      await flush();

      const anchor = container.querySelector('[data-testid="document-annotation-panel-anchor"]') as HTMLElement | null;
      const panel = container.querySelector('[data-testid="document-annotation-panel"]') as HTMLElement | null;
      expect(anchor).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(anchor!.style.left).toBe("524px");
      expect(anchor!.style.width).toBe("360px");
      expect(panel!.style.width).toBe("360px");
      expect(parseFloat(anchor!.style.left) + parseFloat(anchor!.style.width)).toBeLessThanOrEqual(884);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("auto-opens the panel and focuses the thread when deep-linked", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: "thread-99" })]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} locationHash="#document-plan&thread=thread-99" />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const panel = container.querySelector('[data-testid="document-annotation-panel"]');
    expect(panel).not.toBeNull();
    const focusedThread = container.querySelector('[data-thread-id="thread-99"][data-focused]');
    expect(focusedThread).not.toBeNull();
  });

  it("shows a disabled reason in the panel when the draft is dirty", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} draftDirty initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const reason = container.querySelector(
      '[data-testid="document-annotation-disabled-reason"]',
    );
    expect(reason).not.toBeNull();
    expect(reason!.textContent).toMatch(/draft/i);
  });

  it("filters resolved threads behind their tab", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: "resolved" }),
    ]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    // Open filter shows only open
    expect(container.querySelector('[data-thread-id="open-1"]')).not.toBeNull();
    expect(container.querySelector('[data-thread-id="resolved-1"]')).toBeNull();

    // Switch to Resolved
    const resolvedTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.startsWith("Resolved"),
    );
    expect(resolvedTab).not.toBeUndefined();
    await act(async () => resolvedTab!.click());
    await flush();

    expect(container.querySelector('[data-thread-id="resolved-1"]')).not.toBeNull();
  });

  it("renders author name + role from agent and user maps", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({
        id: "open-1",
        comments: [
          {
            id: "comment-board",
            companyId: "co-1",
            threadId: "open-1",
            issueId: "issue-1",
            documentId: "doc-1",
            body: "From the board.",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            createdByRunId: null,
            createdAt: new Date("2026-04-01T00:01:00Z"),
            updatedAt: new Date("2026-04-01T00:01:00Z"),
          },
          {
            id: "comment-agent",
            companyId: "co-1",
            threadId: "open-1",
            issueId: "issue-1",
            documentId: "doc-1",
            body: "From the agent.",
            authorType: "agent",
            authorAgentId: "agent-uxdesigner",
            authorUserId: null,
            createdByRunId: "run-1",
            createdAt: new Date("2026-04-01T00:02:00Z"),
            updatedAt: new Date("2026-04-01T00:02:00Z"),
          },
        ],
      }),
    ]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    const agentMap = new Map([["agent-uxdesigner", { id: "agent-uxdesigner", name: "UXDesigner" }]]);
    const userProfileMap = new Map([["user-1", { label: "Dotta", image: null }]]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DocumentAnnotationsCountChip
            issueId="issue-1"
            docKey={doc.key}
            panelOpen
            onToggle={() => {}}
          />
          <IssueDocumentAnnotations
            issueId="issue-1"
            doc={doc}
            bodyMarkdown={doc.body}
            draftDirty={false}
            draftConflicted={false}
            historicalPreview={false}
            locationHash=""
            panelOpen
            onPanelOpenChange={() => {}}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
          >
            <p>Body</p>
          </IssueDocumentAnnotations>
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    // Click the open thread to expand it.
    const threadCard = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    expect(threadCard).not.toBeNull();
    await act(async () => threadCard!.click());
    await flush();

    const expandedText = container.querySelector('[data-thread-id="open-1"]')?.textContent ?? "";
    expect(expandedText).toContain("Dotta");
    expect(expandedText).not.toContain("· board");
    expect(expandedText).toContain("UXDesigner");
    expect(expandedText).toContain("· agent");
  });

  it("does not render a persistent New comment on selection hint when panel is open", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const cta = container.querySelector('[data-testid="document-annotation-new-comment-cta"]');
    expect(cta).toBeNull();
    expect(container.textContent).not.toMatch(/New comment on selection/i);
    expect(container.textContent).not.toMatch(/⌘⇧M/);
  });

  it("keeps a captured selection from opening the composer until the layer requests a comment", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const selectOnlyButton = container.querySelector(
      '[data-testid="mock-annotation-selection-only"]',
    ) as HTMLButtonElement | null;
    expect(selectOnlyButton).not.toBeNull();
    await act(async () => {
      selectOnlyButton!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="document-annotation-composer"]')).toBeNull();

    expect(container.querySelector('[data-testid="document-annotation-new-comment-cta"]')).toBeNull();
    const directRequestButton = container.querySelector(
      '[data-testid="mock-annotation-selection"]',
    ) as HTMLButtonElement | null;
    expect(directRequestButton).not.toBeNull();
    await act(async () => {
      directRequestButton!.click();
    });
    await flush();

    const composer = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(container.textContent).toContain(mockPendingAnchor.selectedText);
  });

  it("creates a thread from a captured selection and refreshes the shared annotations query", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    mockAnnotationsApi.create.mockResolvedValue(makeThread({ id: "created-1" }));
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    expect(mockAnnotationsApi.list).toHaveBeenCalledTimes(1);

    const selectButton = container.querySelector('[data-testid="mock-annotation-selection"]') as HTMLButtonElement | null;
    expect(selectButton).not.toBeNull();
    await act(async () => {
      selectButton!.click();
    });
    await flush();

    const composer = container.querySelector('[data-testid="document-annotation-composer"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    await act(async () => {
      setTextareaValue(composer!, "New anchored comment");
    });
    await flush();

    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Comment",
    );
    expect(submit).not.toBeUndefined();
    await act(async () => {
      submit!.click();
    });
    await flush();
    await flush();

    expect(mockAnnotationsApi.create).toHaveBeenCalledWith("issue-1", "plan", {
      baseRevisionId: "rev-4",
      baseRevisionNumber: 4,
      selector: mockPendingAnchor.selector,
      body: "New anchored comment",
    });
    expect(mockAnnotationsApi.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("shows resolve and reopen actions and updates thread status", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: "resolved" }),
    ]);
    mockAnnotationsApi.updateStatus.mockResolvedValue(makeThread({ id: "open-1", status: "resolved" }));
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness doc={doc} initialPanelOpen />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const openThread = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    expect(openThread).not.toBeNull();
    await act(async () => openThread!.click());
    await flush();

    const resolveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => /\bResolve\b/.test(button.textContent ?? ""),
    );
    expect(resolveButton).not.toBeUndefined();
    await act(async () => resolveButton!.click());
    await flush();
    expect(mockAnnotationsApi.updateStatus).toHaveBeenCalledWith("issue-1", "plan", "open-1", "resolved");

    const resolvedTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.startsWith("Resolved"),
    );
    expect(resolvedTab).not.toBeUndefined();
    await act(async () => resolvedTab!.click());
    await flush();

    const resolvedThread = container.querySelector('[data-thread-id="resolved-1"]') as HTMLElement | null;
    expect(resolvedThread).not.toBeNull();
    await act(async () => resolvedThread!.click());
    await flush();

    const reopenButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reopen"),
    );
    expect(reopenButton).not.toBeUndefined();
    await act(async () => reopenButton!.click());
    await flush();
    expect(mockAnnotationsApi.updateStatus).toHaveBeenCalledWith("issue-1", "plan", "resolved-1", "open");
  });

  it("renders the mobile annotation panel through the sheet path", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const doc = makeDoc();

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Harness doc={doc} initialPanelOpen />
          </QueryClientProvider>,
        );
      });
      await flush();
      await flush();

      const sheet = container.querySelector('[data-slot="sheet-content"]');
      expect(sheet).not.toBeNull();
      expect(sheet?.getAttribute("data-side")).toBe("bottom");
      expect(sheet?.className).toContain("paperclip-doc-annotation-sheet");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
