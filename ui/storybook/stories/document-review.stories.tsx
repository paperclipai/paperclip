import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertTriangle } from "lucide-react";
import type {
  CompanyDocument,
  DocumentReviewIndex,
  DocumentSuggestionWithComments,
} from "@paperclipai/shared";
import { DocumentReviewRail } from "@/components/documents/DocumentReviewRail";
import { DoneReviewingDialog } from "@/components/documents/DoneReviewingDialog";
import { SuggestionCard } from "@/components/documents/SuggestionCard";
import { SelectionToolbar } from "@/components/documents/SelectionToolbar";
import { DocumentHeader, DOC_TYPE_ICON } from "@/pages/DocumentDetail";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";

/**
 * Storybook coverage for the document detail / review surface (PAP-10568).
 *
 * Renders the real review rail, suggestion cards, and selection toolbar with
 * fixture data so UX/QA can capture desktop screenshots for sign-off without a
 * live backend. Behaviour is unit-tested alongside each component.
 */

const HOUR = 1000 * 60 * 60;
const now = new Date("2026-06-07T12:00:00Z").getTime();

const agentMap = new Map([
  ["agent-claude", { id: "agent-claude", name: "ClaudeCoder" }],
  ["agent-cto", { id: "agent-cto", name: "CTO" }],
]);

function suggestion(overrides: Partial<DocumentSuggestionWithComments>): DocumentSuggestionWithComments {
  return {
    id: "sug",
    companyId: "c",
    issueId: "i",
    documentId: "d",
    documentKey: "spec",
    kind: "substitution",
    status: "pending",
    anchorState: "active",
    anchorConfidence: "exact",
    originalRevisionId: "rev-12",
    originalRevisionNumber: 12,
    currentRevisionId: "rev-12",
    currentRevisionNumber: 12,
    selectedText: "review state and suggested edits.",
    proposedText: "review state, suggested edits, and orphan reconciliation.",
    insertionPosition: null,
    prefixText: "",
    suffixText: "",
    normalizedStart: 0,
    normalizedEnd: 10,
    markdownStart: 0,
    markdownEnd: 10,
    anchorSelector: {
      quote: { exact: "review state and suggested edits.", prefix: "", suffix: "" },
      position: { normalizedStart: 0, normalizedEnd: 10, markdownStart: 0, markdownEnd: 10 },
    },
    createdByAgentId: "agent-claude",
    createdByUserId: null,
    acceptedByAgentId: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptedRevisionId: null,
    rejectedByAgentId: null,
    rejectedByUserId: null,
    rejectedAt: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date(now - 2 * HOUR),
    updatedAt: new Date(now - 2 * HOUR),
    comments: [
      {
        id: "sc1",
        companyId: "c",
        suggestionId: "sug",
        issueId: "i",
        documentId: "d",
        body: "Looks right. Ship.",
        authorType: "agent",
        authorAgentId: "agent-cto",
        authorUserId: null,
        createdByRunId: null,
        createdAt: new Date(now - HOUR),
        updatedAt: new Date(now - HOUR),
      },
    ],
    ...overrides,
  };
}

const reviewIndex: DocumentReviewIndex = {
  issueId: "i",
  documentId: "d",
  documentKey: "spec",
  latestRevisionId: "rev-12",
  latestRevisionNumber: 12,
  counts: {
    unresolved: 4,
    openAnchoredThreads: 2,
    openReviewThreads: 1,
    pendingSuggestions: 3,
    resolvedAnchoredThreads: 1,
    resolvedReviewThreads: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 1,
    resolvedSuggestions: 0,
    staleAnchors: 1,
    orphanedAnchors: 1,
  },
  annotationThreads: [
    {
      id: "t-open",
      companyId: "c",
      issueId: "i",
      documentId: "d",
      documentKey: "spec",
      status: "open",
      anchorState: "active",
      anchorConfidence: "exact",
      originalRevisionId: "rev-12",
      originalRevisionNumber: 12,
      currentRevisionId: "rev-12",
      currentRevisionNumber: 12,
      selectedText: "the orchestrator should never proceed",
      prefixText: "",
      suffixText: "",
      normalizedStart: 0,
      normalizedEnd: 10,
      markdownStart: 0,
      markdownEnd: 10,
      anchorSelector: { quote: { exact: "the orchestrator should never proceed", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 10, markdownStart: 0, markdownEnd: 10 } },
      createdByAgentId: "agent-claude",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date(now - 2 * HOUR),
      updatedAt: new Date(now - 2 * HOUR),
      comments: [
        { id: "tc1", companyId: "c", threadId: "t-open", issueId: "i", documentId: "d", body: "Worth being more explicit here?", authorType: "agent", authorAgentId: "agent-claude", authorUserId: null, createdByRunId: null, createdAt: new Date(now - 2 * HOUR), updatedAt: new Date(now - 2 * HOUR) },
        { id: "tc2", companyId: "c", threadId: "t-open", issueId: "i", documentId: "d", body: "Agreed. Add an example for the \"no, never proceed\" path.", authorType: "agent", authorAgentId: "agent-cto", authorUserId: null, createdByRunId: null, createdAt: new Date(now - HOUR), updatedAt: new Date(now - HOUR) },
      ],
    },
    {
      id: "t-stale",
      companyId: "c",
      issueId: "i",
      documentId: "d",
      documentKey: "spec",
      status: "open",
      anchorState: "stale",
      anchorConfidence: "fuzzy",
      originalRevisionId: "rev-11",
      originalRevisionNumber: 11,
      currentRevisionId: "rev-12",
      currentRevisionNumber: 12,
      selectedText: "anchored text that drifted",
      prefixText: "",
      suffixText: "",
      normalizedStart: 0,
      normalizedEnd: 10,
      markdownStart: 0,
      markdownEnd: 10,
      anchorSelector: { quote: { exact: "anchored text that drifted", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 10, markdownStart: 0, markdownEnd: 10 } },
      createdByAgentId: "agent-cto",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date(now - 5 * HOUR),
      updatedAt: new Date(now - 5 * HOUR),
      comments: [
        { id: "tc3", companyId: "c", threadId: "t-stale", issueId: "i", documentId: "d", body: "This moved when the intro was rewritten.", authorType: "agent", authorAgentId: "agent-cto", authorUserId: null, createdByRunId: null, createdAt: new Date(now - 5 * HOUR), updatedAt: new Date(now - 5 * HOUR) },
      ],
    },
    {
      id: "t-orphan",
      companyId: "c",
      issueId: "i",
      documentId: "d",
      documentKey: "spec",
      status: "open",
      anchorState: "orphaned",
      anchorConfidence: "missing",
      originalRevisionId: "rev-9",
      originalRevisionNumber: 9,
      currentRevisionId: "rev-12",
      currentRevisionNumber: 12,
      selectedText: "a paragraph that was deleted entirely",
      prefixText: "",
      suffixText: "",
      normalizedStart: 0,
      normalizedEnd: 10,
      markdownStart: 0,
      markdownEnd: 10,
      anchorSelector: { quote: { exact: "a paragraph that was deleted entirely", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 10, markdownStart: 0, markdownEnd: 10 } },
      createdByAgentId: "agent-claude",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date(now - 8 * HOUR),
      updatedAt: new Date(now - 8 * HOUR),
      comments: [
        { id: "tc4", companyId: "c", threadId: "t-orphan", issueId: "i", documentId: "d", body: "Where did this section go?", authorType: "agent", authorAgentId: "agent-claude", authorUserId: null, createdByRunId: null, createdAt: new Date(now - 8 * HOUR), updatedAt: new Date(now - 8 * HOUR) },
      ],
    },
  ],
  reviewThreads: [
    {
      id: "overall",
      companyId: "c",
      issueId: "i",
      documentId: "d",
      documentKey: "spec",
      status: "open",
      createdByAgentId: "agent-cto",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date(now - 3 * HOUR),
      updatedAt: new Date(now - 3 * HOUR),
      comments: [
        { id: "oc1", companyId: "c", threadId: "overall", issueId: "i", documentId: "d", body: "Suggestions look right — accept the two pending edits and we can ship.", authorType: "agent", authorAgentId: "agent-cto", authorUserId: null, createdByRunId: null, createdAt: new Date(now - 3 * HOUR), updatedAt: new Date(now - 3 * HOUR) },
      ],
    },
  ],
  suggestions: [
    suggestion({ id: "sug-replace", kind: "substitution" }),
    suggestion({ id: "sug-insert", kind: "insertion", insertionPosition: "after", selectedText: "review flow", proposedText: "Also note the orphan-reconciliation pass.", comments: [] }),
    suggestion({ id: "sug-delete", kind: "deletion", selectedText: "This sentence is redundant and should go.", proposedText: null, comments: [] }),
    suggestion({ id: "sug-rebase", kind: "substitution", currentRevisionId: "rev-11", selectedText: "stale base", proposedText: "needs rebase onto rev 12", comments: [] }),
  ],
};

const noop = () => {};
const asyncNoop = async () => {};

const railHandlers = {
  onReplyThread: asyncNoop,
  onToggleThreadResolved: asyncNoop,
  onAddOverallComment: asyncNoop,
  onAcceptSuggestion: asyncNoop,
  onRejectSuggestion: asyncNoop,
  onResolveSuggestion: asyncNoop,
  onReplySuggestion: asyncNoop,
  onViewSuggestionDiff: noop,
};

const SAMPLE_BODY = `# Paperclip Documents review flow

The orchestrator should never proceed when a reviewer has left blocking
feedback. Review state and suggested edits are tracked as discrete rows so an
agent and a human read the same index.

## Anchored feedback

Highlighted spans carry comments and suggestions. When the body changes, anchors
remap; drifted anchors are flagged **stale** and lost ones become **orphaned**.`;

const meta: Meta = {
  title: "Documents/Review",
};
export default meta;

type Story = StoryObj;

// Real CompanyDocument so the story mounts the production `DocumentHeader` (not a
// hand-rolled copy) — this is what the visual-truth gate requires.
const sampleDoc: CompanyDocument = {
  id: "doc-spec",
  companyId: "c",
  title: "Paperclip Documents review flow",
  format: "markdown",
  status: "in_review",
  documentType: "spec",
  summary: null,
  ownerAgentId: "agent-claude",
  ownerUserId: null,
  latestRevisionId: "rev-12",
  latestRevisionNumber: 12,
  createdByAgentId: "agent-claude",
  createdByUserId: null,
  updatedByAgentId: "agent-claude",
  updatedByUserId: null,
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  sourceTrust: null,
  archivedAt: null,
  archivedByAgentId: null,
  archivedByUserId: null,
  createdAt: new Date(now - 48 * HOUR),
  updatedAt: new Date(now - 2 * HOUR),
  backlinks: [
    { id: "l1", companyId: "c", documentId: "doc-spec", targetType: "issue", targetId: "i1", relationship: "source", issueDocumentId: "id1", issueDocumentKey: "spec", title: "Design Paperclip Documents UX", identifier: "PAP-10520", createdAt: new Date(now), updatedAt: new Date(now) },
    { id: "l2", companyId: "c", documentId: "doc-spec", targetType: "issue", targetId: "i2", relationship: "related", issueDocumentId: null, issueDocumentKey: null, title: "Document review backend", identifier: "PAP-10522", createdAt: new Date(now), updatedAt: new Date(now) },
  ],
  feedbackCounts: {
    openComments: 2,
    resolvedComments: 1,
    openReviewThreads: 1,
    resolvedReviewThreads: 0,
    pendingSuggestions: 3,
    acceptedSuggestions: 0,
    rejectedSuggestions: 1,
    staleAnchors: 1,
    orphanedAnchors: 1,
  },
  body: "",
};

function DetailHeader() {
  return (
    <DocumentHeader
      doc={sampleDoc}
      TypeIcon={DOC_TYPE_ICON[sampleDoc.documentType]}
      ownerName="ClaudeCoder"
      ownerAgentId="agent-claude"
      canEdit
      canReview
      isBoard
      editMode={false}
      lockedByMe={false}
      lockedByOther={false}
      lockHolderName={null}
      onEdit={noop}
      onSuggestEdit={noop}
      onSaveTitle={async () => {}}
      onHistory={noop}
      onToggleLock={noop}
      onCopyLink={noop}
      lockPending={false}
    />
  );
}

export const DetailDesktop: Story = {
  render: () => (
    <div className="flex h-[680px] w-full overflow-hidden rounded-md border border-border bg-background">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <DetailHeader />
        <div className="px-4 pb-8">
          <div className="mx-auto w-full max-w-[78ch]">
            <MarkdownBody>{SAMPLE_BODY}</MarkdownBody>
          </div>
        </div>
      </div>
      <div className="w-[360px] shrink-0">
        <DocumentReviewRail reviewIndex={reviewIndex} canReview canFinishReview latestRevisionId="rev-12" authorMaps={{ agentMap }} {...railHandlers} />
      </div>
    </div>
  ),
};

export const RailComments: Story = {
  render: () => (
    <div className="h-[680px] w-[360px] overflow-hidden rounded-md border border-border">
      <DocumentReviewRail reviewIndex={reviewIndex} canReview canFinishReview latestRevisionId="rev-12" authorMaps={{ agentMap }} {...railHandlers} />
    </div>
  ),
};

export const RailSuggestions: Story = {
  render: () => (
    <div className="h-[680px] w-[360px] overflow-hidden rounded-md border border-border">
      <DocumentReviewRail reviewIndex={reviewIndex} canReview canFinishReview latestRevisionId="rev-12" initialTab="suggestions" authorMaps={{ agentMap }} {...railHandlers} />
    </div>
  ),
};

export const ConflictBanner: Story = {
  render: () => (
    <div
      role="alert"
      className="m-4 flex max-w-3xl flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Someone updated this document while you were editing.</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-8 text-xs">View their changes</Button>
        <Button size="sm" variant="outline" className="h-8 text-xs">Rebase my draft</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:text-destructive">Discard mine</Button>
      </div>
    </div>
  ),
};

/** Mobile review surface — the rail rendered inside its bottom Sheet (≤640px). */
export const RailMobileSheet: Story = {
  name: "Rail — mobile sheet",
  render: () => (
    <DocumentReviewRail
      isMobile
      open
      onOpenChange={noop}
      reviewIndex={reviewIndex}
      canReview
      canFinishReview
      latestRevisionId="rev-12"
      authorMaps={{ agentMap }}
      {...railHandlers}
    />
  ),
};

export const Suggestions: Story = {
  render: () => (
    <div className="w-[340px] space-y-3 p-4">
      <SuggestionCard suggestion={suggestion({ id: "s-replace", kind: "substitution" })} latestRevisionId="rev-12" canReview authorMaps={{ agentMap }} onAccept={asyncNoop} onReject={asyncNoop} onResolve={asyncNoop} onReply={asyncNoop} />
      <SuggestionCard suggestion={suggestion({ id: "s-insert", kind: "insertion", insertionPosition: "after", selectedText: "review flow", proposedText: "Also note the orphan-reconciliation pass.", comments: [] })} latestRevisionId="rev-12" canReview authorMaps={{ agentMap }} onAccept={asyncNoop} onReject={asyncNoop} onResolve={asyncNoop} onReply={asyncNoop} />
      <SuggestionCard suggestion={suggestion({ id: "s-delete", kind: "deletion", selectedText: "This sentence is redundant.", proposedText: null, comments: [] })} latestRevisionId="rev-12" canReview authorMaps={{ agentMap }} onAccept={asyncNoop} onReject={asyncNoop} onResolve={asyncNoop} onReply={asyncNoop} />
      <SuggestionCard suggestion={suggestion({ id: "s-rebase", kind: "substitution", currentRevisionId: "rev-11", selectedText: "stale base", proposedText: "needs rebase", comments: [] })} latestRevisionId="rev-12" canReview authorMaps={{ agentMap }} onAccept={asyncNoop} onReject={asyncNoop} onResolve={asyncNoop} onReply={asyncNoop} />
    </div>
  ),
};

export const SelectionToolbarStory: Story = {
  name: "Selection toolbar",
  render: () => (
    <div className="p-8">
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-popover px-1 py-1 shadow-md">
        <SelectionToolbar onComment={noop} onSuggest={noop} onCopyLink={noop} />
      </div>
    </div>
  ),
};

/** PAP-10570 — the "Done reviewing" handoff dialog opened from the rail CTA. */
export const DoneReviewing: Story = {
  name: "Done-reviewing handoff",
  render: () => (
    <div className="h-[560px] w-full">
      <DoneReviewingDialog
        open
        onOpenChange={noop}
        counts={reviewIndex.counts}
        issueIdentifier="PAP-10520"
        ownerName="ClaudeCoder"
        onSubmit={noop}
      />
    </div>
  ),
};

export const DoneReviewingClean: Story = {
  name: "Done-reviewing handoff (clean)",
  render: () => (
    <div className="h-[560px] w-full">
      <DoneReviewingDialog
        open
        onOpenChange={noop}
        counts={{
          ...reviewIndex.counts,
          openAnchoredThreads: 0,
          openReviewThreads: 0,
          pendingSuggestions: 0,
          staleAnchors: 0,
          orphanedAnchors: 0,
        }}
        issueIdentifier="PAP-10520"
        ownerName="ClaudeCoder"
        onSubmit={noop}
      />
    </div>
  ),
};
