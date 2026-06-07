import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown, FileText, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { CompanyDocumentSummary } from "@paperclipai/shared";
import { DocumentRow } from "@/components/documents/DocumentRow";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Storybook coverage for the company Documents library (PAP-10524, slice 1).
 *
 * Each story renders the real `DocumentRow` component inside the library shell
 * so UX/QA can capture desktop and mobile screenshots without booting a live
 * backend. Filter controls are static here; behaviour is unit-tested in
 * `Documents.test.tsx`.
 */

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
    updatedAt: new Date("2026-06-07T00:00:00Z"),
    backlinks: [],
    feedbackCounts: {
      openComments: 0,
      resolvedComments: 0,
      openReviewThreads: 0,
      resolvedReviewThreads: 0,
      pendingSuggestions: 0,
      acceptedSuggestions: 0,
      rejectedSuggestions: 0,
      staleAnchors: 0,
      orphanedAnchors: 0,
    },
    ...overrides,
  };
}

const HOUR = 1000 * 60 * 60;
const now = new Date("2026-06-07T12:00:00Z").getTime();

const SAMPLE_DOCS: { doc: CompanyDocumentSummary; owner: { name: string }; identifier?: string }[] = [
  {
    doc: makeDocument({
      id: "doc-spec",
      title: "Paperclip Documents review flow",
      documentType: "spec",
      status: "in_review",
      summary: "Library + review surfaces, anchored comments, suggestions, handoff.",
      updatedAt: new Date(now - 2 * HOUR),
      backlinks: [
        { identifier: "PAP-10520" } as never,
        { identifier: "PAP-10522" } as never,
      ],
      feedbackCounts: {
        ...makeDocument({}).feedbackCounts,
        openComments: 12,
        pendingSuggestions: 3,
      },
    }),
    owner: { name: "ClaudeCoder" },
    identifier: "ux-spec",
  },
  {
    doc: makeDocument({
      id: "doc-plan",
      title: "Onboarding for new agents",
      documentType: "plan",
      status: "draft",
      summary: "Goal — get a new agent productive in their first heartbeat.",
      updatedAt: new Date(now - 5 * HOUR),
      feedbackCounts: { ...makeDocument({}).feedbackCounts, openComments: 4 },
    }),
    owner: { name: "CEO" },
    identifier: "plan",
  },
  {
    doc: makeDocument({
      id: "doc-brief",
      title: "Q3 hiring snapshot",
      documentType: "brief",
      status: "approved",
      summary: "Headcount, open roles, and budget envelope for the quarter.",
      updatedAt: new Date(now - 26 * HOUR),
    }),
    owner: { name: "CTO" },
    identifier: "q3-hiring",
  },
  {
    doc: makeDocument({
      id: "doc-report",
      title: "Incident review — stalled review loops",
      documentType: "report",
      status: "in_review",
      summary: "Why work stopped and the product rule that prevents recurrence.",
      updatedAt: new Date(now - 3 * HOUR),
      sourceTrust: { preset: "low", disposition: "quarantined" } as never,
      feedbackCounts: {
        ...makeDocument({}).feedbackCounts,
        openReviewThreads: 2,
        staleAnchors: 1,
      },
    }),
    owner: { name: "Researcher" },
    identifier: "incident-42",
  },
  {
    doc: makeDocument({
      id: "doc-other",
      title: "Glossary of Paperclip terms",
      documentType: "other",
      status: "archived",
      updatedAt: new Date(now - 40 * HOUR),
    }),
    owner: { name: "Docs Bot" },
    identifier: "glossary",
  },
];

function LibraryShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground p-6">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search documents..." className="h-9 pl-9 text-sm" readOnly />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-8 bg-accent">
              Status (1)
            </Button>
            <Button variant="outline" size="sm" className="h-8">
              Type
            </Button>
            <Button variant="outline" size="sm" className="h-8">
              Owner
            </Button>
            <Button variant="outline" size="sm" className="h-8">
              Linked
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1">
              Updated ↓
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="More filters">
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button variant="default" size="sm" className="h-8 gap-1">
              <Plus className="h-3.5 w-3.5" />
              New document
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1 rounded-md bg-accent/60 px-2 py-1 font-medium">
            Status: In review
            <X className="h-3 w-3 text-muted-foreground" />
          </span>
          <button className="rounded-md px-2 py-1 font-medium text-muted-foreground">Clear all</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Pages/Documents Library",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

export const Populated: Story = {
  render: () => (
    <LibraryShell>
      <div className="overflow-hidden rounded-md border border-border">
        {SAMPLE_DOCS.map(({ doc, owner, identifier }) => (
          <DocumentRow
            key={doc.id}
            document={doc}
            to={`/documents/${doc.id}`}
            owner={owner}
            identifier={identifier}
            companyPrefix="PAP"
          />
        ))}
      </div>
    </LibraryShell>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="bg-background text-foreground p-6">
      <div className="mx-auto w-full max-w-5xl">
        <EmptyState
          icon={FileText}
          message="No documents yet. Plans, specs, and briefs from across the company will appear here for review."
          action="New document"
          onAction={() => {}}
        />
      </div>
    </div>
  ),
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <div className="bg-background text-foreground p-3" style={{ maxWidth: 390 }}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search documents..." className="h-9 pl-9 text-sm" readOnly />
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          {SAMPLE_DOCS.slice(0, 4).map(({ doc, owner, identifier }) => (
            <DocumentRow
              key={doc.id}
              document={doc}
              to={`/documents/${doc.id}`}
              owner={owner}
              identifier={identifier}
              companyPrefix="PAP"
            />
          ))}
        </div>
      </div>
    </div>
  ),
};
