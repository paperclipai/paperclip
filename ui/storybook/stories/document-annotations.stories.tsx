import { useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  DocumentAnnotationThreadWithComments,
  Issue,
  IssueDocument,
} from "@paperclipai/shared";
import { DocumentAnnotationPanel } from "@/components/DocumentAnnotationPanel";
import { DocumentAnnotationLayer, type PendingAnchor } from "@/components/DocumentAnnotationLayer";
import {
  DocumentAnnotationsCountChip,
  IssueDocumentAnnotations,
} from "@/components/IssueDocumentAnnotations";
import { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { queryKeys } from "@/lib/queryKeys";
import type { CompanyUserProfile } from "@/lib/company-members";

const sampleMarkdown = `# Plan: Document Highlights And Comment Threads

We should **keep** the current markdown document stack for the first version.
The existing editor is MDXEditor on top of Lexical, and the current code already uses Lexical-level customization.

## Reader And Goal

Reader: board reviewer, CTO, and implementing engineers.

## Anchor Strategy

Do not insert comment markers into markdown. The markdown document body must
remain portable and readable.

Use a sidecar anchor made from two selectors:

- Text quote selector: exact selected text plus prefix/suffix context.
- Text position selector: normalized rendered-text offsets plus markdown source offsets.

## Future Work

Phase 5 covers QA validation across desktop and mobile.`;

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
    selectedText: "keep the current markdown document stack",
    prefixText: "We should ",
    suffixText: " for the first version",
    normalizedStart: 0,
    normalizedEnd: 40,
    markdownStart: 0,
    markdownEnd: 40,
    anchorSelector: {
      quote: {
        exact: "keep the current markdown document stack",
        prefix: "We should ",
        suffix: " for the first version",
      },
      position: { normalizedStart: 0, normalizedEnd: 40, markdownStart: 0, markdownEnd: 40 },
    },
    createdByAgentId: null,
    createdByUserId: "user-1",
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-05-12T10:00:00Z"),
    updatedAt: new Date("2026-05-12T10:01:00Z"),
    comments: [
      {
        id: "comment-1",
        companyId: "co-1",
        threadId: id,
        issueId: "issue-1",
        documentId: "doc-1",
        body: "Could we benchmark the editor against a CRDT alternative before committing?",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        createdAt: new Date("2026-05-12T10:00:00Z"),
        updatedAt: new Date("2026-05-12T10:00:00Z"),
      },
      {
        id: "comment-2",
        companyId: "co-1",
        threadId: id,
        issueId: "issue-1",
        documentId: "doc-1",
        body: "We did a small spike — happy to share results in the plan.",
        authorType: "agent",
        authorAgentId: "agent-uxdesigner",
        authorUserId: null,
        createdByRunId: "run-1",
        createdAt: new Date("2026-05-12T10:01:00Z"),
        updatedAt: new Date("2026-05-12T10:01:00Z"),
      },
    ],
    ...overrides,
  };
}

const baseThreads: DocumentAnnotationThreadWithComments[] = [
  makeThread({ id: "open-1" }),
  makeThread({
    id: "stale-1",
    anchorState: "stale",
    anchorConfidence: "fuzzy",
    selectedText: "two selectors",
    prefixText: "anchor made from ",
    suffixText: ":",
    comments: [
      {
        id: "comment-stale",
        companyId: "co-1",
        threadId: "stale-1",
        issueId: "issue-1",
        documentId: "doc-1",
        body: "Original wording was slightly different — re-anchor when convenient.",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        createdAt: new Date("2026-05-12T11:00:00Z"),
        updatedAt: new Date("2026-05-12T11:00:00Z"),
      },
    ],
  }),
  makeThread({
    id: "resolved-1",
    status: "resolved",
    selectedText: "Reader: board reviewer, CTO, and implementing engineers",
    comments: [
      {
        id: "comment-resolved",
        companyId: "co-1",
        threadId: "resolved-1",
        issueId: "issue-1",
        documentId: "doc-1",
        body: "Updated reader list to add the security lead.",
        authorType: "agent",
        authorAgentId: "agent-uxdesigner",
        authorUserId: null,
        createdByRunId: "run-1",
        createdAt: new Date("2026-05-12T12:00:00Z"),
        updatedAt: new Date("2026-05-12T12:00:00Z"),
      },
    ],
  }),
  makeThread({
    id: "orphan-1",
    anchorState: "orphaned",
    selectedText: "an earlier paragraph that has been rewritten",
    comments: [
      {
        id: "comment-orphan",
        companyId: "co-1",
        threadId: "orphan-1",
        issueId: "issue-1",
        documentId: "doc-1",
        body: "This anchor lost its location after the rewrite. Original quote preserved.",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        createdAt: new Date("2026-05-12T13:00:00Z"),
        updatedAt: new Date("2026-05-12T13:00:00Z"),
      },
    ],
  }),
];

const integratedAgentMap: ReadonlyMap<string, Pick<Agent, "id" | "name">> = new Map([
  ["agent-uxdesigner", { id: "agent-uxdesigner", name: "UXDesigner" }],
]);
const integratedUserProfileMap: ReadonlyMap<string, CompanyUserProfile> = new Map([
  ["user-1", { label: "Dotta", image: null }],
]);

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const integratedIssueId = "issue-storybook-1";
const integratedDoc: IssueDocument = {
  id: "doc-storybook-1",
  companyId: "co-1",
  issueId: integratedIssueId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: sampleMarkdown,
  latestRevisionId: "rev-4",
  latestRevisionNumber: 4,
  createdByAgentId: null,
  createdByUserId: "user-1",
  updatedByAgentId: null,
  updatedByUserId: "user-1",
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: new Date("2026-05-12T09:00:00Z"),
  updatedAt: new Date("2026-05-12T10:01:00Z"),
};

function makeIntegratedIssue(): Issue {
  return {
    id: integratedIssueId,
    companyId: "co-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Highlighting and comments on documents",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 9402,
    identifier: "PAP-9402",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    milestoneId: null,
    targetDate: null,
    documentSummaries: [
      {
        id: integratedDoc.id,
        companyId: integratedDoc.companyId,
        issueId: integratedIssueId,
        key: integratedDoc.key,
        title: integratedDoc.title,
        format: integratedDoc.format,
        latestRevisionId: integratedDoc.latestRevisionId,
        latestRevisionNumber: integratedDoc.latestRevisionNumber,
        createdByAgentId: null,
        createdByUserId: "user-1",
        updatedByAgentId: null,
        updatedByUserId: "user-1",
        lockedAt: integratedDoc.lockedAt,
        lockedByAgentId: integratedDoc.lockedByAgentId,
        lockedByUserId: integratedDoc.lockedByUserId,
        createdAt: integratedDoc.createdAt,
        updatedAt: integratedDoc.updatedAt,
      },
    ],
    legacyPlanDocument: null,
    planDocument: integratedDoc,
    createdAt: new Date("2026-05-10T00:00:00Z"),
    updatedAt: new Date("2026-05-12T10:01:00Z"),
  };
}

/**
 * Storybook fetch stub for the integrated stories. The annotation surface is
 * driven by prefilled React Query data, but MarkdownEditor in edit mode can
 * fire an autosave PUT on first onChange. Without this stub the cell would
 * render a "Request failed: 404" string from the section's error state — which
 * defeats the purpose of the integrated capture.
 */
function useIntegratedFetchStub(issueId: string, doc: IssueDocument) {
  // Install once per mount; the cleanup restores the previous fetch.
  // The preview's global fetch fixture is still in place — we only intercept
  // the document mutation URL pattern for this issue.
  useMemo(() => {
    if (typeof window === "undefined") return;
    const upsertUrlPath = `/api/issues/${issueId}/documents/${doc.key}`;
    const original = window.fetch.bind(window);
    const wrapped: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname === upsertUrlPath && (method === "PUT" || method === "GET")) {
        return Response.json({ ...doc, latestRevisionNumber: doc.latestRevisionNumber + 1 });
      }
      return original(input, init);
    };
    window.fetch = wrapped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId, doc.key]);
}

function IntegratedSurface({
  threads = baseThreads,
  focusedThreadId = "open-1",
  initialPanelOpen = true,
  beginEditOnMount = false,
}: {
  threads?: DocumentAnnotationThreadWithComments[];
  focusedThreadId?: string | null;
  initialPanelOpen?: boolean;
  beginEditOnMount?: boolean;
}) {
  const issue = useMemo(makeIntegratedIssue, []);
  useIntegratedFetchStub(issue.id, integratedDoc);
  const queryClient = useMemo(() => {
    const client = makeClient();
    // Prefill documents + annotations cache so React Query renders without hitting the network.
    client.setQueryData(queryKeys.issues.documents(issue.id), [integratedDoc]);
    client.setQueryData(
      queryKeys.issues.documentAnnotations(issue.id, integratedDoc.key, "all"),
      threads,
    );
    return client;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id]);

  const panelKeys = initialPanelOpen ? [integratedDoc.key] : [];
  const focusedThreadIds = focusedThreadId ? { [integratedDoc.key]: focusedThreadId } : undefined;
  const editKey = beginEditOnMount ? integratedDoc.key : null;

  return (
    <QueryClientProvider client={queryClient}>
      <div className="paperclip-doc-annotation-integrated mx-auto max-w-[1320px] p-4">
        <div className="rounded-lg border border-border bg-background p-4">
          <IssueDocumentsSection
            issue={issue}
            canDeleteDocuments={false}
            agentMap={integratedAgentMap}
            userProfileMap={integratedUserProfileMap}
            defaultAnnotationPanelOpenKeys={panelKeys}
            defaultAnnotationFocusedThreadIds={focusedThreadIds}
            forceEditDocumentKey={editKey}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

function DirtyDraftWithIntegratedHeader() {
  const issue = useMemo(makeIntegratedIssue, []);
  useIntegratedFetchStub(issue.id, integratedDoc);
  const queryClient = useMemo(() => {
    const client = makeClient();
    client.setQueryData(queryKeys.issues.documents(issue.id), [integratedDoc]);
    client.setQueryData(
      queryKeys.issues.documentAnnotations(issue.id, integratedDoc.key, "all"),
      baseThreads,
    );
    return client;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [draftBody, setDraftBody] = useState(`${sampleMarkdown}\n\nA work-in-progress edit that is unsaved.`);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="paperclip-doc-annotation-integrated mx-auto max-w-[1320px] p-4">
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h3 className="w-full text-sm font-medium text-muted-foreground shrink-0 sm:w-auto">Documents</h3>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground">▾</span>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      plan
                    </span>
                    <span className="text-[11px] text-muted-foreground">rev 4 ▾</span>
                    <span className="truncate text-[11px] text-muted-foreground">updated 2h ago</span>
                    <DocumentAnnotationsCountChip
                      issueId={issue.id}
                      docKey={integratedDoc.key}
                      panelOpen={panelOpen}
                      onToggle={() => setPanelOpen((current) => !current)}
                    />
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-3">
                <IssueDocumentAnnotations
                  issueId={issue.id}
                  doc={integratedDoc}
                  bodyMarkdown={draftBody}
                  draftDirty
                  draftConflicted={false}
                  historicalPreview={false}
                  locationHash=""
                  panelOpen={panelOpen}
                  onPanelOpenChange={setPanelOpen}
                  agentMap={integratedAgentMap}
                  userProfileMap={integratedUserProfileMap}
                  defaultFocusedThreadId="open-1"
                >
                  <MarkdownEditor
                    value={draftBody}
                    onChange={(body) => setDraftBody(body)}
                    placeholder="Markdown body"
                    bordered={false}
                    className="bg-transparent"
                    contentClassName="paperclip-edit-in-place-content min-h-[220px] text-[15px] leading-7"
                  />
                </IssueDocumentAnnotations>
                <div className="flex min-h-4 items-center justify-end px-1">
                  <span className="text-[11px] text-amber-300">Autosaving…</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}

function StatesShowcase({ focusedThreadId = "open-1" }: { focusedThreadId?: string }) {
  const queryClient = useMemo(() => makeClient(), []);
  const bodyRef = useRef<HTMLElement | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  const [focused, setFocused] = useState<string | null>(focusedThreadId);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative rounded-lg border border-border bg-card p-4">
          <section
            ref={(element) => {
              bodyRef.current = element;
            }}
            className="relative"
          >
            <MarkdownBody className="text-[15px] leading-7">{sampleMarkdown}</MarkdownBody>
            <DocumentAnnotationLayer
              containerRef={bodyRef}
              markdown={sampleMarkdown}
              threads={baseThreads.map((thread) => ({
                id: thread.id,
                selectedText: thread.selectedText,
                status: thread.status,
                anchorState: thread.anchorState,
              }))}
              focusedThreadId={focused}
              onThreadFocus={(id) => setFocused(id)}
              pendingAnchor={pendingAnchor}
              onPendingAnchorChange={setPendingAnchor}
              onRequestComment={() => {}}
              hideResolved={false}
            />
          </section>
        </div>
        <DocumentAnnotationPanel
          open
          onOpenChange={() => {}}
          issueId="issue-1"
          documentKey="plan"
          documentRevisionNumber={4}
          baseRevisionId="rev-4"
          baseRevisionNumber={4}
          threads={baseThreads}
          focusedThreadId={focused}
          focusedCommentId={null}
          onFocusThread={(id) => setFocused(id)}
          pendingAnchor={null}
          onClearPendingAnchor={() => setPendingAnchor(null)}
          agentMap={integratedAgentMap}
          userProfileMap={integratedUserProfileMap}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Product/Documents/Annotations",
  component: StatesShowcase,
  parameters: {
    docs: {
      description: {
        component:
          "Document annotation surface for issue documents. Stories under 'Integrated' render the real IssueDocumentsSection chrome (count chip in header, panel + body in their actual layout). Stories under 'States' isolate the panel/layer for unit-level visual debugging.",
      },
    },
  },
} satisfies Meta<typeof StatesShowcase>;

export default meta;

type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Integrated stories — render IssueDocumentsSection with all chrome.
// These are the captures the UX gate requires.
// ---------------------------------------------------------------------------

export const IntegratedDesktopOpen: Story = {
  parameters: { viewport: { defaultViewport: "responsive" } },
  render: () => <IntegratedSurface focusedThreadId="open-1" initialPanelOpen />,
};

export const IntegratedDesktopZeroComments: Story = {
  parameters: { viewport: { defaultViewport: "responsive" } },
  render: () => <IntegratedSurface threads={[]} initialPanelOpen={false} focusedThreadId={null} />,
};

export const IntegratedDesktopEditMode: Story = {
  parameters: { viewport: { defaultViewport: "responsive" } },
  render: () => (
    <IntegratedSurface focusedThreadId="open-1" initialPanelOpen beginEditOnMount />
  ),
};

export const IntegratedDesktopDirtyDraft: Story = {
  parameters: { viewport: { defaultViewport: "responsive" } },
  render: () => <DirtyDraftWithIntegratedHeader />,
};

export const IntegratedMobileBottomSheet: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <IntegratedSurface focusedThreadId="open-1" initialPanelOpen />,
};

// ---------------------------------------------------------------------------
// Isolated state stories (kept for unit-level visual debugging).
// ---------------------------------------------------------------------------

export const DesktopOpenFocused: Story = {
  render: () => <StatesShowcase focusedThreadId="open-1" />,
};

export const DesktopResolvedFocused: Story = {
  render: () => <StatesShowcase focusedThreadId="resolved-1" />,
};

export const DesktopStaleFocused: Story = {
  render: () => <StatesShowcase focusedThreadId="stale-1" />,
};

export const DesktopOrphanedFocused: Story = {
  render: () => <StatesShowcase focusedThreadId="orphan-1" />,
};
