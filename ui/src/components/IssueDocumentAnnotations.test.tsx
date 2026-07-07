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

const mockAnnotationsApi = vi.hoisted(() => {
  const api = {
    list: vi.fn(),
    listForTarget: vi.fn(),
    get: vi.fn(),
    getForTarget: vi.fn(),
    create: vi.fn(),
    createForTarget: vi.fn(),
    addComment: vi.fn(),
    addCommentForTarget: vi.fn(),
    updateStatus: vi.fn(),
    updateStatusForTarget: vi.fn(),
  };
  api.listForTarget.mockImplementation((target, options) =>
    target.kind === "issue" ? api.list(target.issueId, target.documentKey, options) : api.list(target.routineId, target.documentKey, options));
  api.getForTarget.mockImplementation((target, threadId) =>
    target.kind === "issue" ? api.get(target.issueId, target.documentKey, threadId) : api.get(target.routineId, target.documentKey, threadId));
  api.createForTarget.mockImplementation((target, data) =>
    target.kind === "issue" ? api.create(target.issueId, target.documentKey, data) : api.create(target.routineId, target.documentKey, data));
  api.addCommentForTarget.mockImplementation((target, threadId, data) =>
    target.kind === "issue" ? api.addComment(target.issueId, target.documentKey, threadId, data) : api.addComment(target.routineId, target.documentKey, threadId, data));
  api.updateStatusForTarget.mockImplementation((target, threadId, status) =>
    target.kind === "issue" ? api.updateStatus(target.issueId, target.documentKey, threadId, status) : api.updateStatus(target.routineId, target.documentKey, threadId, status));
  return api;
});

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

function dispatchSubmitShortcut(textarea: HTMLTextAreaElement) {
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
  );
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
    expect(anchor?.className).toContain("z-[60]");
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

  it("offsets the desktop annotation panel from the document with a left margin when there is room", async () => {
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
        return rectFor(0, 0, 1400, 800);
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
      expect(anchor).not.toBeNull();
      // The document body ends at 640; the panel should clear it with a margin
      // rather than sitting flush against the document's right edge.
      expect(parseFloat(anchor!.style.left)).toBeGreaterThan(640);
      expect(anchor!.style.left).toBe("664px");
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

  it("shows open and resolved threads together in a single list (no filter tabs)", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: "resolved" }),
      makeThread({ id: "orphan-1", anchorState: "orphaned" }),
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

    // Open + resolved both render without any filter interaction.
    expect(container.querySelector('[data-thread-id="open-1"]')).not.toBeNull();
    expect(container.querySelector('[data-thread-id="resolved-1"]')).not.toBeNull();
    // Orphaned threads can't be anchored in the doc, so they stay hidden.
    expect(container.querySelector('[data-thread-id="orphan-1"]')).toBeNull();

    // The Open/Resolved/Stale/Orphaned filter chips are gone.
    const filterChip = Array.from(container.querySelectorAll("button")).find((button) =>
      ["Open", "Resolved", "Stale", "Orphaned"].includes((button.textContent ?? "").trim()),
    );
    expect(filterChip).toBeUndefined();
  });

  it("orders threads by document position, not API/recency order", async () => {
    // Returned out of document order: later-in-doc first, earlier-in-doc last.
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "thread-late", normalizedStart: 900, markdownStart: 900 }),
      makeThread({ id: "thread-early", normalizedStart: 10, markdownStart: 10 }),
      makeThread({ id: "thread-mid", normalizedStart: 400, markdownStart: 400 }),
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

    const order = Array.from(container.querySelectorAll("[data-thread-id]"))
      .map((el) => el.getAttribute("data-thread-id"));
    expect(order).toEqual(["thread-early", "thread-mid", "thread-late"]);
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

    const expandedThread = container.querySelector('[data-thread-id="open-1"]');
    const expandedText = expandedThread?.textContent ?? "";
    expect(expandedText).toContain("Dotta");
    expect(expandedText).not.toContain("· board");
    expect(expandedText).toContain("UXDesigner");
    expect(expandedText).toContain("· agent");
    // Each rendered comment shows an author avatar.
    const avatars = expandedThread?.querySelectorAll('[data-slot="avatar"]') ?? [];
    expect(avatars.length).toBe(2);
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

  it("keeps the composer visible with the draft when creating a thread fails", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    mockAnnotationsApi.create.mockRejectedValue(new Error("Annotation anchor does not match the current document revision"));
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

    const composerAfterFailure = container.querySelector('[data-testid="document-annotation-composer"]') as HTMLTextAreaElement | null;
    expect(composerAfterFailure).not.toBeNull();
    expect(composerAfterFailure!.value).toBe("New anchored comment");
    expect(container.querySelector('[data-testid="document-annotation-error"]')?.textContent)
      .toContain("Annotation anchor does not match the current document revision");
  });

  it("submits a new anchored comment with ⌘↵", async () => {
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

    const selectButton = container.querySelector('[data-testid="mock-annotation-selection"]') as HTMLButtonElement | null;
    await act(async () => selectButton!.click());
    await flush();

    const composer = container.querySelector('[data-testid="document-annotation-composer"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    await act(async () => setTextareaValue(composer!, "Submitted via shortcut"));
    await flush();
    await act(async () => dispatchSubmitShortcut(composer!));
    await flush();
    await flush();

    expect(mockAnnotationsApi.create).toHaveBeenCalledWith("issue-1", "plan", {
      baseRevisionId: "rev-4",
      baseRevisionNumber: 4,
      selector: mockPendingAnchor.selector,
      body: "Submitted via shortcut",
    });
  });

  it("submits a reply with ⌘↵", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: "open-1" })]);
    mockAnnotationsApi.addComment.mockResolvedValue(makeThread({ id: "open-1" }).comments[0]);
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
    await act(async () => openThread!.click());
    await flush();

    const reply = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(reply).not.toBeNull();
    await act(async () => setTextareaValue(reply!, "Replying via shortcut"));
    await flush();
    await act(async () => dispatchSubmitShortcut(reply!));
    await flush();
    await flush();

    expect(mockAnnotationsApi.addComment).toHaveBeenCalledWith("issue-1", "plan", "open-1", {
      body: "Replying via shortcut",
    });
  });

  it("keeps a reply draft visible when submitting the reply fails", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: "open-1" })]);
    mockAnnotationsApi.addComment.mockRejectedValue(new Error("Failed to add reply"));
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

    const reply = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(reply).not.toBeNull();
    await act(async () => setTextareaValue(reply!, "Reply should stay visible"));
    await flush();

    const replyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reply",
    );
    expect(replyButton).not.toBeUndefined();
    await act(async () => replyButton!.click());
    await flush();
    await flush();

    const replyAfterFailure = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(replyAfterFailure).not.toBeNull();
    expect(replyAfterFailure!.value).toBe("Reply should stay visible");
    expect(container.querySelector('[data-testid="document-annotation-error"]')?.textContent)
      .toContain("Failed to add reply");
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

    // Resolved threads stay in the same list (filter tabs were removed).
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
      expect(sheet?.className).toContain("z-[60]");
      expect(sheet?.className).toContain("bg-popover");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
