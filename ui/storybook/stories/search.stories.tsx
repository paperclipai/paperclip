import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CompanySearchResult, CompanySearchResponse } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { Input } from "@/components/ui/input";
import { PageTabBar, type PageTabItem } from "@/components/PageTabBar";
import { MatchSourceChip } from "@/components/search/MatchSourceChip";
import { SearchResultRow } from "@/components/search/SearchResultRow";
import { Tabs } from "@/components/ui/tabs";
import {
  Bot,
  CircleDot,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  Plus,
  Search as SearchIcon,
  SquarePen,
  Target,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { StatusBadge } from "@/components/StatusBadge";
import { storybookAgents, storybookProjects, storybookIssues } from "../fixtures/paperclipData";

const agentsById = new Map(storybookAgents.map((agent) => [agent.id, agent]));

type IssueResultOverrides = Omit<Partial<CompanySearchResult>, "issue"> & {
  issue?: Partial<NonNullable<CompanySearchResult["issue"]>>;
};

function buildIssueResult(overrides: IssueResultOverrides): CompanySearchResult {
  const baseIssue = {
    id: overrides.issue?.id ?? "issue-1",
    identifier: overrides.issue?.identifier ?? "PAP-3142",
    title: overrides.issue?.title ?? "Auth middleware flakes on cold-start when session token is rotated",
    status: overrides.issue?.status ?? "in_progress",
    priority: overrides.issue?.priority ?? "high",
    assigneeAgentId: overrides.issue?.assigneeAgentId ?? storybookAgents[0]?.id ?? null,
    assigneeUserId: overrides.issue?.assigneeUserId ?? null,
    projectId: overrides.issue?.projectId ?? storybookProjects[0]?.id ?? null,
    updatedAt: overrides.issue?.updatedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  } satisfies NonNullable<CompanySearchResult["issue"]>;
  return {
    id: overrides.id ?? baseIssue.id,
    type: "issue",
    score: 100,
    title: `${baseIssue.identifier} ${baseIssue.title}`,
    href: `/PAP/issues/${baseIssue.identifier}`,
    matchedFields: overrides.matchedFields ?? ["title"],
    sourceLabel: overrides.sourceLabel ?? null,
    snippet: overrides.snippet ?? null,
    snippets: overrides.snippets ?? [],
    issue: baseIssue,
    updatedAt: baseIssue.updatedAt,
    previewImageUrl: overrides.previewImageUrl ?? null,
  };
}

const fixtureResults: CompanySearchResult[] = [
  buildIssueResult({
    id: "issue-1",
    matchedFields: ["title", "comment"],
    sourceLabel: "Comment",
    snippet: "we hit another flake in the morning batch — auth middleware",
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Auth middleware flakes on cold-start when session token is rotated",
        highlights: [{ start: 0, end: 4 }],
      },
      {
        field: "comment",
        label: "Comment",
        text: "we hit another flake in the morning batch — auth middleware ate the request",
        highlights: [{ start: 16, end: 21 }, { start: 47, end: 51 }],
      },
    ],
  }),
  buildIssueResult({
    id: "issue-2",
    issue: {
      id: "issue-2",
      identifier: "PAP-3091",
      title: "Audit auth flake telemetry from last quarter",
      status: "in_review",
      assigneeAgentId: storybookAgents[1]?.id ?? null,
    },
    matchedFields: ["title", "document"],
    sourceLabel: "Document",
    snippet: "the deflake plan ranks auth regressions above latency tickets",
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Audit auth flake telemetry from last quarter",
        highlights: [{ start: 6, end: 10 }],
      },
      {
        field: "document",
        label: "PLAN",
        text: "the deflake plan ranks auth regressions above latency tickets",
        highlights: [{ start: 12, end: 16 }, { start: 26, end: 30 }],
      },
    ],
    previewImageUrl:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23a78bfa'/><text x='50' y='55' font-size='14' fill='white' text-anchor='middle' font-family='sans-serif'>chart</text></svg>",
  }),
  buildIssueResult({
    id: "issue-3",
    issue: {
      id: "issue-3",
      identifier: "PAP-2748",
      title: "Pin worker registration to a single auth backend",
      status: "done",
      assigneeAgentId: null,
    },
    matchedFields: ["title", "identifier"],
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Pin worker registration to a single auth backend",
        highlights: [{ start: 36, end: 40 }],
      },
    ],
  }),
];

const fixtureAgents: CompanySearchResult[] = storybookAgents.slice(0, 1).map((agent) => ({
  id: agent.id,
  type: "agent" as const,
  score: 80,
  title: agent.name,
  href: `/PAP/agents/${agent.id}`,
  matchedFields: ["agent"],
  sourceLabel: "Agent",
  snippet: agent.capabilities ?? null,
  snippets: agent.capabilities
    ? [
        {
          field: "capabilities",
          label: "Agent",
          text: agent.capabilities,
          highlights: [],
        },
      ]
    : [],
  updatedAt: new Date().toISOString(),
  previewImageUrl: null,
}));

const fixtureProjects: CompanySearchResult[] = storybookProjects.slice(0, 1).map((project) => ({
  id: project.id,
  type: "project" as const,
  score: 70,
  title: project.name,
  href: `/PAP/projects/${project.id}`,
  matchedFields: ["project"],
  sourceLabel: "Project",
  snippet: project.description ?? null,
  snippets: project.description
    ? [
        {
          field: "description",
          label: "Project",
          text: project.description,
          highlights: [],
        },
      ]
    : [],
  updatedAt: new Date().toISOString(),
  previewImageUrl: null,
}));

const fixtureResponse: CompanySearchResponse = {
  query: "auth flake",
  normalizedQuery: "auth flake",
  scope: "all",
  limit: 20,
  offset: 0,
  results: [...fixtureResults, ...fixtureAgents, ...fixtureProjects],
  countsByType: {
    issue: fixtureResults.length,
    agent: fixtureAgents.length,
    project: fixtureProjects.length,
  },
  hasMore: false,
};

function ScopeTabsPreview({
  active,
  response,
}: {
  active: "all" | "issues" | "comments" | "documents" | "agents" | "projects";
  response: CompanySearchResponse;
}) {
  const total =
    (response.countsByType.issue ?? 0) +
    (response.countsByType.agent ?? 0) +
    (response.countsByType.project ?? 0);
  const items: PageTabItem[] = [
    { value: "all", label: <ScopeTabLabel label="All" count={total} /> },
    { value: "issues", label: <ScopeTabLabel label="Issues" count={response.countsByType.issue} /> },
    { value: "comments", label: <ScopeTabLabel label="Comments" count={response.results.filter((result) => result.matchedFields.includes("comment")).length} /> },
    { value: "documents", label: <ScopeTabLabel label="Documents" count={response.results.filter((result) => result.matchedFields.includes("document")).length} /> },
    { value: "agents", label: <ScopeTabLabel label="Agents" count={response.countsByType.agent} /> },
    { value: "projects", label: <ScopeTabLabel label="Projects" count={response.countsByType.project} /> },
  ];
  return (
    <Tabs value={active}>
      <PageTabBar items={items} value={active} align="start" />
    </Tabs>
  );
}

function ScopeTabLabel({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex items-center">
      {label}
      <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] tabular-nums font-normal">
        {count}
      </Badge>
    </span>
  );
}

function SearchPagePreview({
  response,
  state,
  query,
}: {
  response: CompanySearchResponse;
  state: "results" | "empty" | "loading" | "initial";
  query: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            readOnly
            placeholder="Search issues, comments, documents, agents, projects…"
            className="h-10 pl-9 pr-20 text-sm"
            aria-label="Search query"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </div>
      </div>
      <div className="border-b border-border px-2 sm:px-4">
        <ScopeTabsPreview active="all" response={response} />
      </div>

      {state === "results" ? (
        <div className="flex w-full max-w-[960px] flex-col px-2 sm:px-4">
          <div className="flex items-center justify-between py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>{response.results.length} results · sorted by relevance</span>
          </div>
          <section aria-label="Issues" className="flex flex-col">
            <IssueGroupHeader
              label="Issues"
              trailing={
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {fixtureResults.length}
                </span>
              }
              className="pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground"
            />
            <div className="flex flex-col gap-y-1">
              {fixtureResults.map((result) => (
                <SearchResultRow
                  key={result.id}
                  result={result}
                  agentsById={agentsById}
                />
              ))}
            </div>
          </section>
          <section aria-label="Agents" className="mt-6 flex flex-col">
            <IssueGroupHeader
              label="Agents"
              trailing={
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {fixtureAgents.length}
                </span>
              }
              className="pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground"
            />
            <div className="flex flex-col gap-y-1">
              {fixtureAgents.map((result) => (
                <SearchResultRow key={result.id} result={result} />
              ))}
            </div>
          </section>
          <section aria-label="Projects" className="mt-6 flex flex-col">
            <IssueGroupHeader
              label="Projects"
              trailing={
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {fixtureProjects.length}
                </span>
              }
              className="pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground"
            />
            <div className="flex flex-col gap-y-1">
              {fixtureProjects.map((result) => (
                <SearchResultRow key={result.id} result={result} />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {state === "empty" ? (
        <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <div className="text-base font-semibold">
            No results for &ldquo;{query}&rdquo;
          </div>
          <p className="text-sm text-muted-foreground">
            We couldn&rsquo;t find a match in all scopes. Try widening the scope or rephrasing your query.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <li>Try fewer tokens or a single distinctive term.</li>
            <li>Use an identifier shortcut like <code className="rounded bg-muted px-1 py-0.5">PAP-123</code>.</li>
          </ul>
        </div>
      ) : null}

      {state === "loading" ? (
        <div className="flex flex-col gap-2 px-2 py-3 sm:px-4">
          <div className="px-3 text-xs text-muted-foreground">Searching for &ldquo;{query}&rdquo;…</div>
          <div className="flex flex-col">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-start gap-3 px-3 py-2">
                <div className="mt-1 h-4 w-4 rounded-full bg-muted" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {state === "initial" ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">Type to search company memory.</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Issues, comments, plan documents, agents, projects — same surface, ranked by relevance.
            </p>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Identifier lookup:</span> type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">PAP-123</code> to jump straight to an issue.
            </li>
            <li>
              <span className="font-medium text-foreground">Quoted phrases:</span> wrap a phrase in quotes to match the
              exact sequence.
            </li>
            <li>
              <span className="font-medium text-foreground">⌘K:</span> reopens the command palette pre-seeded with your
              current query.
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CommandPaletteWithSearchAll({
  query,
  emptyResults = false,
}: {
  query: string;
  emptyResults?: boolean;
}) {
  return (
    <Command className="rounded-md border border-border bg-popover shadow-lg">
      <CommandInput value={query} readOnly placeholder="Search issues, agents, projects..." />
      <CommandList className="max-h-none">
        {emptyResults ? (
          <CommandEmpty>
            <span>
              No quick issue matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">↵</kbd>{" "}
              to <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          </CommandEmpty>
        ) : null}
        <CommandGroup heading="Search">
          <CommandItem
            value="search-all"
            className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
          >
            <SearchIcon className="mr-2 h-4 w-4" />
            <span className="flex-1 truncate">
              Search all for <span className="font-semibold">&ldquo;{query}&rdquo;</span>
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>open full search</span>
              <kbd className="rounded border border-border bg-background px-1 py-0.5 text-[10px]">↵</kbd>
            </span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem>
            <SquarePen className="mr-2 h-4 w-4" />
            Create new issue
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem>
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Pages">
          <CommandItem>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem>
            <CircleDot className="mr-2 h-4 w-4" />
            Issues
          </CommandItem>
          <CommandItem>
            <Target className="mr-2 h-4 w-4" />
            Goals
          </CommandItem>
          <CommandItem>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
          </CommandItem>
          <CommandItem>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>
        {!emptyResults ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Issues">
              {storybookIssues.slice(0, 3).map((issue) => (
                <CommandItem key={issue.id}>
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  <StatusBadge status={issue.status} />
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Projects">
          {storybookProjects.slice(0, 2).map((project) => (
            <CommandItem key={project.id}>
              <Hexagon className="mr-2 h-4 w-4" />
              {project.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function SearchStories() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner max-w-[1320px] space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Search</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Full search page and Command K handoff</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Snippet-forward results, scope tabs, match-source chips, and the supporting empty / loading / initial
            states. Cmd K palette renders the persistent &ldquo;Search all for…&rdquo; row when a query is non-empty.
          </p>
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Results, query &ldquo;auth flake&rdquo;</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="results" query="auth flake" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Initial state — no query</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="initial" query="" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Loading skeleton</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="loading" query="auth flake" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">No results state</h2>
          </div>
          <SearchPagePreview response={{ ...fixtureResponse, results: [], countsByType: { issue: 0, agent: 0, project: 0 } }} state="empty" query="ghostbuster" />
        </section>

        <section className="paperclip-story__frame overflow-hidden p-4">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">Match-source chips</div>
            <h2 className="mt-1 text-lg font-semibold">Type-coded chip variants</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-2">
            <MatchSourceChip kind="title" />
            <MatchSourceChip kind="identifier" />
            <MatchSourceChip kind="comment" count={3} />
            <MatchSourceChip kind="document" />
            <MatchSourceChip kind="document" count={2} label="Doc" />
          </div>
        </section>

        <section className="paperclip-story__frame overflow-hidden p-4">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">Cmd+K palette</div>
            <h2 className="mt-1 text-lg font-semibold">Search-all row with quick results</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                With quick issue matches
              </div>
              <CommandPaletteWithSearchAll query="auth flake" />
            </div>
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                Empty results — Enter routes to /search
              </div>
              <CommandPaletteWithSearchAll query="ghostbuster" emptyResults />
            </div>
          </div>
        </section>

        <section className="paperclip-story__frame overflow-hidden p-4">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">Search result row</div>
            <h2 className="mt-1 text-lg font-semibold">Issue, agent, project rows</h2>
          </div>
          <div className="flex w-full max-w-[960px] flex-col gap-y-1">
            {fixtureResults.map((result) => (
              <SearchResultRow
                key={result.id}
                result={result}
                agentsById={agentsById}
              />
            ))}
            {fixtureAgents.map((result) => (
              <SearchResultRow key={result.id} result={result} />
            ))}
            {fixtureProjects.map((result) => (
              <SearchResultRow key={result.id} result={result} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Search & Command K",
  component: SearchStories,
  parameters: {
    docs: {
      description: {
        component:
          "Full search page surfaces and Command K Search-all handoff. Reuses StatusIcon, StatusBadge, Identity, IssueGroupHeader, and PageTabBar; adds MatchSourceChip + SearchResultRow.",
      },
    },
  },
} satisfies Meta<typeof SearchStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SearchSurfaces: Story = {};
