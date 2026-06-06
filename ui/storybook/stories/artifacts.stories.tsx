import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ArrowLeft, Check, Layers, Package, Search, X } from "lucide-react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn, formatDate } from "@/lib/utils";
import type { CompanyArtifact } from "@/api/artifacts";
import {
  ARTIFACT_GROUP_OPTIONS,
  ARTIFACT_KIND_FILTERS,
  artifactGroupByLabel,
} from "@/pages/Artifacts";

/**
 * Storybook coverage for the company Artifacts page. Covers:
 *  - the flat grid (PAP-10359)
 *  - the new group-by control, stack cards, and selected stack view (PAP-10440 / PAP-10442)
 *
 * Each story is renderable standalone so UX/QA can capture desktop and mobile
 * screenshots without booting a live backend.
 */

type StoryArtifactKindFilter = (typeof ARTIFACT_KIND_FILTERS)[number]["value"];
type StoryArtifactGroupBy = (typeof ARTIFACT_GROUP_OPTIONS)[number]["value"];

const SAMPLE_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#6366f1'/><stop offset='1' stop-color='#22d3ee'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='50%' y='52%' font-family='sans-serif' font-size='28' fill='white' text-anchor='middle'>Hero render.png</text></svg>`,
  );

const SAMPLE_IMAGE_TEAL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#0ea5e9'/><stop offset='1' stop-color='#14b8a6'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='50%' y='52%' font-family='sans-serif' font-size='24' fill='white' text-anchor='middle'>nav-revised.png</text></svg>`,
  );

const SAMPLE_IMAGE_AMBER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f59e0b'/><stop offset='1' stop-color='#ef4444'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='50%' y='52%' font-family='sans-serif' font-size='22' fill='white' text-anchor='middle'>hero-warm.png</text></svg>`,
  );

function makeArtifact(overrides: Partial<CompanyArtifact>): CompanyArtifact {
  return {
    id: "art",
    source: "attachment",
    mediaKind: "image",
    title: "Artifact",
    previewText: null,
    contentType: null,
    contentPath: null,
    openPath: null,
    downloadPath: null,
    issue: { id: "issue-1", identifier: "PAP-10306", title: "Landing visuals refresh" },
    project: { id: "proj-1", name: "Paperclip App" },
    createdByAgent: { id: "agent-1", name: "ClaudeCoder" },
    updatedAt: new Date("2026-06-04T12:00:00Z").toISOString(),
    href: "/issues/PAP-10306#attachment-art",
    ...overrides,
  };
}

const ARTIFACTS: CompanyArtifact[] = [
  makeArtifact({
    id: "wp-video",
    source: "work_product",
    mediaKind: "video",
    title: "Product demo — primary cut.mp4",
    contentType: "video/mp4",
    contentPath: null,
    openPath: "/files/demo.mp4",
    downloadPath: "/files/demo.mp4?download=1",
    issue: { id: "issue-2", identifier: "PAP-10205", title: "Record the launch walkthrough" },
    href: "/issues/PAP-10205#work-product-wp-video",
  }),
  makeArtifact({
    id: "img-hero",
    mediaKind: "image",
    title: "Hero render.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE,
    openPath: SAMPLE_IMAGE,
    downloadPath: SAMPLE_IMAGE,
  }),
  makeArtifact({
    id: "doc-plan",
    source: "document",
    mediaKind: "document",
    title: "Artifacts Page Plan",
    previewText:
      "Build a company-level Artifacts page at /{companyPrefix}/artifacts, with a sidebar item below Goals and a three-column artifact grid. The page should make agent-produced work easy to find without becoming another attachment dump.",
    contentType: "text/markdown",
    issue: { id: "issue-3", identifier: "PAP-10341", title: "Draft the rollout plan" },
    createdByAgent: { id: "agent-2", name: "CodexCoder" },
    href: "/issues/PAP-10341#document-plan",
  }),
  makeArtifact({
    id: "txt-notes",
    mediaKind: "text",
    title: "review-notes.txt",
    previewText:
      "Reviewed the primary cut. Color grade looks good; trim the first 1.2s of dead air. Re-export at 1080p and attach the final to the issue.",
    contentType: "text/plain",
    openPath: "/files/review-notes.txt",
    downloadPath: "/files/review-notes.txt?download=1",
    issue: { id: "issue-2", identifier: "PAP-10205", title: "Record the launch walkthrough" },
  }),
  makeArtifact({
    id: "file-zip",
    mediaKind: "file",
    title: "design-assets.zip",
    contentType: "application/zip",
    openPath: "/files/design-assets.zip",
    downloadPath: "/files/design-assets.zip?download=1",
    issue: { id: "issue-1", identifier: "PAP-10306", title: "Landing visuals refresh" },
  }),
  makeArtifact({
    id: "img-broken",
    mediaKind: "image",
    title: "missing-preview.png (broken source)",
    contentType: "image/png",
    contentPath: "/files/does-not-exist.png",
    openPath: "/files/does-not-exist.png",
    downloadPath: "/files/does-not-exist.png?download=1",
  }),
];

function ArtifactsGrid({ artifacts }: { artifacts: CompanyArtifact[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {artifacts.map((artifact) => (
        <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouping mock components (PAP-10442). These mirror the production artifact
// grouping controls so Storybook stays useful for visual review.
// ---------------------------------------------------------------------------

/**
 * Toolbar replica matching the existing Artifacts page (search + kind filters)
 * with the group-by icon control placed before the filter chips.
 */
function ArtifactsToolbar({
  query,
  onQueryChange,
  kind,
  onKindChange,
  groupBy,
  onGroupByChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  kind: StoryArtifactKindFilter;
  onKindChange: (value: StoryArtifactKindFilter) => void;
  groupBy: StoryArtifactGroupBy;
  onGroupByChange: (value: StoryArtifactGroupBy) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search artifacts..."
          aria-label="Search artifacts"
          className="h-9 pl-9 pr-9 text-sm"
        />
        {query.length > 0 ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear artifact search"
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")}
              title="Group artifacts"
              aria-label={`Group artifacts (currently ${artifactGroupByLabel(groupBy)})`}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Group by</DropdownMenuLabel>
            {ARTIFACT_GROUP_OPTIONS.map(({ value, label }) => (
              <DropdownMenuItem
                key={value}
                aria-selected={groupBy === value}
                onSelect={() => onGroupByChange(value)}
                className="justify-between"
              >
                {label}
                {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter artifacts by type">
          {ARTIFACT_KIND_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="tab"
              aria-selected={kind === filter.value}
              onClick={() => onKindChange(filter.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                kind === filter.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface MockGroup {
  id: string;
  groupBy: Exclude<StoryArtifactGroupBy, "none">;
  issueIdentifier: string;
  issueTitle: string;
  count: number;
  preview: CompanyArtifact;
  updatedAt: string;
  href: string;
}

/**
 * Stack card mock for grouped views.
 *
 * Visual rules (matching ArtifactCard footprint):
 *  - Same border, radius (rounded-[8px]), border + bg-card surface, hover treatment.
 *  - Preview frame is the same `aspect-video` PreviewFrame as ArtifactCard.
 *  - Footer block has the same vertical rhythm.
 *  - When `count > 1`, render two stacked sibling layers behind the main card,
 *    offset by 4px / 8px on both axes, with reduced opacity. This produces a
 *    subtle "stack" without competing with the preview content.
 *  - Stack count badge sits in the top-right of the preview as a small pill.
 *  - The body line replaces the artifact title with the issue identifier and
 *    title; metadata line shows the artifact count and most-recent-edit time.
 */
function ArtifactStackCard({ group }: { group: MockGroup }) {
  const isStacked = group.count > 1;

  return (
    <div className="relative">
      {isStacked ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 translate-x-[8px] translate-y-[8px] rounded-[8px] border border-border bg-muted/40 shadow-sm"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 translate-x-[4px] translate-y-[4px] rounded-[8px] border border-border bg-muted/70 shadow-sm"
          />
        </>
      ) : null}

      <a
        href={group.href}
        data-testid="artifact-stack-card"
        data-stack-count={group.count}
        className="group relative flex flex-col overflow-hidden rounded-[8px] border border-border bg-card transition-colors hover:border-foreground/20"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-accent/20">
          {group.preview.contentPath ? (
            <img
              src={group.preview.contentPath}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-accent/15 text-muted-foreground/40">
              <Layers className="h-8 w-8" aria-hidden="true" />
            </div>
          )}
          <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-2 py-0.5 text-[11px] font-medium text-foreground/90 shadow-sm backdrop-blur">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {group.count}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          <div className="flex h-7 items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {group.issueIdentifier}
            </span>
            <h3
              className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-foreground/85"
              title={group.issueTitle}
            >
              {group.issueTitle}
            </h3>
          </div>

          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/65">
            <span>{group.count} artifacts</span>
            <span className="text-muted-foreground/50">·</span>
            <span>Updated {formatDate(group.updatedAt)}</span>
          </div>
        </div>
      </a>
    </div>
  );
}

const TASK_GROUPS: MockGroup[] = [
  {
    id: "task:issue-1",
    groupBy: "task",
    issueIdentifier: "PAP-10306",
    issueTitle: "Landing visuals refresh",
    count: 5,
    preview: makeArtifact({ mediaKind: "image", contentPath: SAMPLE_IMAGE }),
    updatedAt: new Date("2026-06-04T12:00:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-1",
  },
  {
    id: "task:issue-2",
    groupBy: "task",
    issueIdentifier: "PAP-10205",
    issueTitle: "Record the launch walkthrough",
    count: 3,
    preview: makeArtifact({ mediaKind: "video", contentPath: null }),
    updatedAt: new Date("2026-06-03T09:30:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-2",
  },
  {
    id: "task:issue-3",
    groupBy: "task",
    issueIdentifier: "PAP-10341",
    issueTitle: "Draft the rollout plan",
    count: 2,
    preview: makeArtifact({ mediaKind: "document", contentPath: null }),
    updatedAt: new Date("2026-06-02T18:15:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-3",
  },
  {
    id: "task:issue-4",
    groupBy: "task",
    issueIdentifier: "PAP-10412",
    issueTitle: "Investigate paywall regression",
    count: 1,
    preview: makeArtifact({ mediaKind: "image", contentPath: SAMPLE_IMAGE_AMBER }),
    updatedAt: new Date("2026-06-02T11:00:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-4",
  },
  {
    id: "task:issue-5",
    groupBy: "task",
    issueIdentifier: "PAP-10391",
    issueTitle: "Iterate on nav",
    count: 4,
    preview: makeArtifact({ mediaKind: "image", contentPath: SAMPLE_IMAGE_TEAL }),
    updatedAt: new Date("2026-06-01T16:42:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-5",
  },
  {
    id: "task:issue-6",
    groupBy: "task",
    issueIdentifier: "PAP-10377",
    issueTitle: "QA: empty states",
    count: 1,
    preview: makeArtifact({ mediaKind: "text", previewText: "All empty states green except onboarding-step-3." }),
    updatedAt: new Date("2026-05-31T10:00:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-6",
  },
];

const PARENT_TASK_GROUPS: MockGroup[] = [
  {
    id: "parent_task:root-1",
    groupBy: "parent_task",
    issueIdentifier: "PAP-10300",
    issueTitle: "Launch readiness epic",
    count: 14,
    preview: makeArtifact({ mediaKind: "image", contentPath: SAMPLE_IMAGE }),
    updatedAt: new Date("2026-06-04T12:00:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=parent_task&groupIssueId=root-1",
  },
  {
    id: "parent_task:root-2",
    groupBy: "parent_task",
    issueIdentifier: "PAP-10200",
    issueTitle: "Marketing site rebuild",
    count: 9,
    preview: makeArtifact({ mediaKind: "image", contentPath: SAMPLE_IMAGE_TEAL }),
    updatedAt: new Date("2026-06-03T14:25:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=parent_task&groupIssueId=root-2",
  },
  {
    id: "parent_task:root-3",
    groupBy: "parent_task",
    issueIdentifier: "PAP-10180",
    issueTitle: "Pricing experiment",
    count: 1,
    preview: makeArtifact({ mediaKind: "document", previewText: "Decision log" }),
    updatedAt: new Date("2026-05-30T08:11:00Z").toISOString(),
    href: "/PAP/artifacts?groupBy=parent_task&groupIssueId=root-3",
  },
];

const SELECTED_GROUP_ARTIFACTS: CompanyArtifact[] = [
  makeArtifact({
    id: "img-hero",
    mediaKind: "image",
    title: "Hero render.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE,
    openPath: SAMPLE_IMAGE,
    downloadPath: SAMPLE_IMAGE,
  }),
  makeArtifact({
    id: "img-teal",
    mediaKind: "image",
    title: "nav-revised.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE_TEAL,
  }),
  makeArtifact({
    id: "img-amber",
    mediaKind: "image",
    title: "hero-warm.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE_AMBER,
  }),
  makeArtifact({
    id: "file-zip",
    mediaKind: "file",
    title: "design-assets.zip",
    contentType: "application/zip",
    openPath: "/files/design-assets.zip",
    downloadPath: "/files/design-assets.zip?download=1",
  }),
  makeArtifact({
    id: "txt-spec",
    mediaKind: "text",
    title: "design-spec.txt",
    previewText:
      "Hero retains pearl gradient. Nav collapses to icon-rail under 640px. Card radius is 8px throughout. Keep accent button consistent with /design-guide.",
  }),
];

const meta: Meta = {
  title: "Pages/Artifacts",
};

export default meta;

type Story = StoryObj;

/**
 * Flat grid (existing behaviour) — group control is set to `None` so the
 * toolbar shows the new icon in its inert state.
 */
export const Grid: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("none");
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
        <ArtifactsGrid artifacts={ARTIFACTS} />
      </div>
    );
  },
};

/**
 * Grouped by Task — the production default. Every stack is one issue's
 * artifacts. Counts > 1 show the subtle stack effect; the lone `count = 1`
 * stacks render flat to keep the grid honest about depth.
 */
export const GroupedByTask: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("task");
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {TASK_GROUPS.map((group) => (
            <ArtifactStackCard key={group.id} group={group} />
          ))}
        </div>
      </div>
    );
  },
};

/**
 * Grouped by Parent task — stacks cluster all descendants under the root
 * issue identifier. Same visual contract as task grouping.
 */
export const GroupedByParentTask: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("parent_task");
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {PARENT_TASK_GROUPS.map((group) => (
            <ArtifactStackCard key={group.id} group={group} />
          ))}
        </div>
      </div>
    );
  },
};

/**
 * Selected stack — drilled into a single issue's artifacts. The header row
 * is the back affordance plus the selected-group label; media filter and
 * search remain available and still apply within the stack.
 */
export const SelectedStack: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("task");
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />

        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <a
              href="/PAP/artifacts?groupBy=task"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              All stacks
            </a>
            <span className="text-muted-foreground/40" aria-hidden="true">
              /
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">PAP-10306</span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground/90">
              Landing visuals refresh
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Layers className="h-3 w-3" aria-hidden="true" />
            <span>{SELECTED_GROUP_ARTIFACTS.length} artifacts in this stack</span>
          </div>
        </div>

        <ArtifactsGrid artifacts={SELECTED_GROUP_ARTIFACTS} />
      </div>
    );
  },
};

/**
 * Mobile — confirms the toolbar wrap (search above, group icon + kind chips
 * below) and that stack cards keep their stack effect at single-column width.
 */
export const MobileGrouping: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("task");
    return (
      <div className="mx-auto w-full max-w-md space-y-5 p-4">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
        <div className="grid grid-cols-1 gap-6">
          {TASK_GROUPS.slice(0, 3).map((group) => (
            <ArtifactStackCard key={group.id} group={group} />
          ))}
        </div>
      </div>
    );
  },
};

export const Empty: Story = {
  render: () => (
    <div className="mx-auto max-w-6xl p-6">
      <EmptyState
        icon={Package}
        message="No artifacts yet. Agent-produced documents, media, and files will appear here."
      />
    </div>
  ),
};
