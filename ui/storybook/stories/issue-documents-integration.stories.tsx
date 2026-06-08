import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown, Copy, ExternalLink, FileText, MoreHorizontal, Plus, Search } from "lucide-react";
import type { CompanyDocumentSummary, DocumentFeedbackCounts as Counts } from "@paperclipai/shared";
import { DocumentRow } from "@/components/documents/DocumentRow";
import { DocumentFeedbackCounts } from "@/components/documents/DocumentFeedbackCounts";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Storybook coverage for the issue ↔ documents integration (PAP-10569, UX spec §6).
 *
 * Renders the real presentational pieces — `DocumentRow`, `DocumentFeedbackCounts`,
 * and the `chip-match-document-*` mention chip — inside static shells so UX/QA can
 * capture sign-off screenshots without a live backend. Interactive behaviour
 * (autosave, linking, navigation) is covered by unit tests.
 */

function emptyCounts(): Counts {
  return {
    openComments: 0,
    resolvedComments: 0,
    openReviewThreads: 0,
    resolvedReviewThreads: 0,
    pendingSuggestions: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 0,
    staleAnchors: 0,
    orphanedAnchors: 0,
  };
}

const HOUR = 1000 * 60 * 60;
const now = new Date("2026-06-07T12:00:00Z").getTime();

function makeDocument(overrides: Partial<CompanyDocumentSummary>): CompanyDocumentSummary {
  return {
    id: "doc",
    companyId: "company-storybook",
    title: "Untitled document",
    format: "markdown",
    status: "in_review",
    documentType: "spec",
    summary: null,
    ownerAgentId: "agent-1",
    ownerUserId: null,
    latestRevisionId: "rev-1",
    latestRevisionNumber: 1,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    sourceTrust: null,
    archivedAt: null,
    archivedByAgentId: null,
    archivedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date(now - 2 * HOUR),
    backlinks: [],
    feedbackCounts: emptyCounts(),
    ...overrides,
  };
}

const ISSUE_KEY = "issue";
const ISSUE_TARGET = "issue-781c5dcf";

function issueBacklink(documentKey: string) {
  return {
    targetType: "issue",
    targetId: ISSUE_TARGET,
    issueDocumentKey: documentKey,
    identifier: "PAP-10569",
  } as never;
}

const PLAN_DOC = makeDocument({
  id: "doc-plan",
  title: "Plan",
  documentType: "plan",
  status: "in_review",
  summary: "Implementation plan for the issue documents tab and ergonomics.",
  updatedAt: new Date(now - 1 * HOUR),
  backlinks: [issueBacklink("plan")],
  feedbackCounts: { ...emptyCounts(), openComments: 5, pendingSuggestions: 2 },
});

const SPEC_DOC = makeDocument({
  id: "doc-spec",
  title: "Documents tab — interaction spec",
  documentType: "spec",
  status: "draft",
  summary: "Scoped search, pinned plan, Add document, cross-issue chip.",
  updatedAt: new Date(now - 6 * HOUR),
  backlinks: [issueBacklink("spec")],
  feedbackCounts: { ...emptyCounts(), openReviewThreads: 1 },
});

const LINKED_REPORT = makeDocument({
  id: "doc-report",
  title: "Roughdraft borrow — findings",
  documentType: "report",
  status: "approved",
  summary: "Cross-linked company document surfaced on the issue.",
  updatedAt: new Date(now - 30 * HOUR),
  backlinks: [{ targetType: "issue", targetId: ISSUE_TARGET, identifier: "PAP-10507" } as never],
});

const TAB_DOCS = [PLAN_DOC, SPEC_DOC, LINKED_REPORT];

function Shell({ children, width = 760 }: { children: React.ReactNode; width?: number }) {
  return (
    <div className="bg-background text-foreground p-6">
      <div className="mx-auto w-full space-y-4" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

/** Reconstructs the inline issue-document card header (Chat surface). */
function InlineDocumentCard({ doc, docKey }: { doc: CompanyDocumentSummary; docKey: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {docKey}
            </span>
            <Button variant="ghost" size="sm" className="h-auto px-1.5 py-0 text-[11px] font-normal text-muted-foreground">
              rev {doc.latestRevisionNumber}
              <ChevronDown className="h-3 w-3" />
            </Button>
            <span className="text-[11px] text-muted-foreground">updated 1h ago</span>
            <DocumentFeedbackCounts counts={doc.feedbackCounts} />
          </div>
          {doc.title && docKey !== "plan" ? <p className="mt-2 text-sm font-medium">{doc.title}</p> : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button asChild variant="ghost" size="icon-xs" className="text-muted-foreground" title="Open in Documents">
            <a href={`/PAP/documents/${doc.id}?from=issue:${docKey}`} aria-label={`Open ${docKey} in Documents`}>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Copy document">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Document actions">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 text-[15px] leading-7 text-muted-foreground">
        {/*
          Production renders the body through `MarkdownBody`; this static fixture uses
          plain prose (no raw markdown literal) so the sign-off screenshot reflects what
          users actually see rather than printing unrendered "## Goal" syntax.
        */}
        {docKey === "plan"
          ? "Preserve inline plan editing while making linked docs discoverable from the issue."
          : doc.summary}
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Pages/Issue Documents Integration",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/** §6.1 — inline card gains an "Open in Documents" button and 💬 / ✎ feedback counts. */
export const InlineCard: Story = {
  render: () => (
    <Shell>
      <h3 className="text-sm font-medium text-muted-foreground">Documents</h3>
      <div className="space-y-3">
        <InlineDocumentCard doc={PLAN_DOC} docKey="plan" />
        <InlineDocumentCard doc={SPEC_DOC} docKey="spec" />
      </div>
    </Shell>
  ),
};

/** §6.2 — the new issue "Documents" tab: scoped search, Add document, pinned plan. */
export const DocumentsTab: Story = {
  render: () => (
    <Shell>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search this issue's documents..." className="h-9 pl-9 text-sm" readOnly />
        </div>
        <Button variant="outline" size="sm" className="h-9 shrink-0">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add document
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        {TAB_DOCS.map((doc) => {
          const key = doc.backlinks.find((b) => b.targetType === "issue")?.issueDocumentKey ?? undefined;
          return (
            <DocumentRow
              key={doc.id}
              document={doc}
              to={`/PAP/documents/${doc.id}?from=issue:${key ?? "PAP-10569"}`}
              identifier={key ?? undefined}
              owner={{ name: "ClaudeCoder" }}
            />
          );
        })}
      </div>
    </Shell>
  ),
};

/** §6.2 — empty state when only the plan is linked. */
export const DocumentsTabEmpty: Story = {
  render: () => (
    <Shell>
      <EmptyState
        icon={FileText}
        message="Only the plan document is linked. Add a spec, brief, or report to keep more context here."
        action="Add document"
        onAction={() => {}}
      />
    </Shell>
  ),
};

/** §6.3 — cross-issue document mention chip using the chip-match-document tokens. */
export const MentionChip: Story = {
  render: () => (
    <Shell width={560}>
      <div className="rounded-lg border border-border bg-card p-4 text-sm leading-7">
        Tracking the rollout in{" "}
        <a
          href="/PAP/documents/doc-spec"
          data-mention-kind="document"
          title="Documents tab — interaction spec · draft · 💬 1"
          className="inline-flex items-center gap-1 rounded-full border px-2 py-px align-[-0.125em] text-[0.85em] font-medium leading-none no-underline bg-[var(--chip-match-document-bg)] text-[var(--chip-match-document-fg)] border-[var(--chip-match-document-border)]"
        >
          <FileText className="h-3 w-3" aria-hidden="true" />
          interaction spec
        </a>{" "}
        — please leave suggestions there before Friday.
      </div>
    </Shell>
  ),
};
