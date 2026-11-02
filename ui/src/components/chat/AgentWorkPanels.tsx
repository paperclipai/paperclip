import { t, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, File, FileText, Image, Search, Video } from "lucide-react";
import type { CompanyArtifact, Issue } from "@paperclipai/shared";
import { artifactsApi } from "@/api/artifacts";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { IssueFiltersPopover } from "@/components/IssueFiltersPopover";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueStatusOrder,
  type IssueFilterState,
} from "@/lib/issue-filters";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDate, formatDateTime, relativeTime } from "@/lib/utils";

/**
 * The agent-scoped side panels shown beside an agent chat: every task the
 * agent has worked on, and every artifact it produced. Both are card stacks
 * so the chat's right column reads as "what this agent has been doing"
 * rather than the properties of the conversation issue itself.
 */

const AGENT_TASK_LIMIT = 200;
const ARTIFACT_PAGE_SIZE = 100;
const ARTIFACT_MAX_PAGES = 5;

export type AgentTaskSortField = "updated" | "created" | "status" | "title";

const sortOptions = (): ReadonlyArray<[AgentTaskSortField, string]> => [
  ["updated", t("oct5Core.s0248")],
  ["created", t("oct5Core.s0249")],
  ["status", t("oct5Core.s0250")],
  ["title", t("oct5Core.s0251")],
];

export function sortAgentTasks(
  tasks: Issue[],
  field: AgentTaskSortField,
  dir: "asc" | "desc",
): Issue[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...tasks].sort((a, b) => {
    switch (field) {
      case "status":
        return sign * (issueStatusOrder.indexOf(a.status) - issueStatusOrder.indexOf(b.status));
      case "title":
        return sign * a.title.localeCompare(b.title);
      case "created":
        return sign * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      default:
        return sign * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    }
  });
}

function PanelMessage({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  useTranslation();
  return (
    <p className={cn("px-1 py-6 text-center text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}

const cardClassName =
  "flex flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AgentTaskCard({ task }: { task: Issue }) {
  useTranslation();
  return (
    <Link
      // design-allow(card-pattern): navigation <Link> card; Card renders a div and would break anchor semantics
      to={`/issues/${task.identifier ?? task.id}`}
      disableIssueQuicklook
      target="_blank"
      rel="noreferrer"
      data-testid="agent-task-card"
      className={cardClassName}
    >
      <div className="flex min-w-0 items-start gap-2">
        <StatusIcon
          status={task.status}
          blockerAttention={task.blockerAttention}
          className="mt-0.5 shrink-0"
        />
        <span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium text-foreground">
          {task.title}
        </span>
      </div>
      <div className="flex items-center gap-1.5 pl-6 text-xs text-muted-foreground">
        <span className="font-mono">{task.identifier ?? task.id.slice(0, 8)}</span>
        <span aria-hidden>·</span>
        <time dateTime={new Date(task.updatedAt).toISOString()} title={formatDateTime(task.updatedAt)}>
          {relativeTime(task.updatedAt)}
        </time>
      </div>
    </Link>
  );
}

export function AgentTasksPanel({
  companyId,
  agentId,
  excludeIssueId,
}: {
  companyId: string;
  agentId: string;
  /** The conversation issue itself, which is not one of the agent's tasks. */
  excludeIssueId?: string;
}) {
  useTranslation();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<IssueFilterState>(defaultIssueFilterState);
  const [sortField, setSortField] = useState<AgentTaskSortField>("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const tasksQuery = useQuery({
    queryKey: queryKeys.issues.listParticipatedByAgent(companyId, agentId),
    queryFn: () => issuesApi.list(companyId, {
      participantAgentId: agentId,
      sortField: "updated",
      sortDir: "desc",
      limit: AGENT_TASK_LIMIT,
    }),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scoped = (tasksQuery.data ?? []).filter((task) => {
      if (task.id === excludeIssueId) return false;
      if (!needle) return true;
      return task.title.toLowerCase().includes(needle)
        || (task.identifier ?? "").toLowerCase().includes(needle);
    });
    return sortAgentTasks(applyIssueFilters(scoped, filters), sortField, sortDir);
  }, [tasksQuery.data, excludeIssueId, query, filters, sortField, sortDir]);

  const activeFilterCount = countActiveIssueFilters(filters);
  const total = (tasksQuery.data ?? []).filter((task) => task.id !== excludeIssueId).length;
  // Search and filters run on the most recently updated tasks only.
  const capped = (tasksQuery.data?.length ?? 0) >= AGENT_TASK_LIMIT;

  return (
    <section className="flex flex-col gap-3" aria-label={t("oct5Core.s0252")}>
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("oct5Core.s0253")}
            aria-label={t("oct5Core.s0253")}
            className="h-8 pl-7 text-sm"
          />
        </div>
        <IssueFiltersPopover
          state={filters}
          onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
          activeFilterCount={activeFilterCount}
          projects={projectsQuery.data?.map((project) => ({ id: project.id, name: project.name }))}
          enableExternalObjectFilters={false}
          buttonVariant="outline"
          iconOnly
          presentation="streamlined"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title={t("oct5Core.s0254")} aria-label={t("oct5Core.s0255")}>
              <ArrowUpDown className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-0">
            <div className="space-y-0.5 p-2">
              {sortOptions().map(([field, label]) => (
                <button
                  key={field}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                    sortField === field ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                  )}
                  onClick={() => {
                    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
                    else {
                      setSortField(field);
                      setSortDir(field === "updated" || field === "created" ? "desc" : "asc");
                    }
                  }}
                >
                  <span>{label}</span>
                  {sortField === field ? (
                    <span className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {tasksQuery.isPending ? (
        <PanelMessage>{t("oct5Core.s0256")}</PanelMessage>
      ) : tasksQuery.isError ? (
        <PanelMessage tone="error">{t("oct5Core.s0257")}</PanelMessage>
      ) : total === 0 ? (
        <PanelMessage>{t("oct5Core.s0258")}</PanelMessage>
      ) : visible.length === 0 ? (
        <PanelMessage>
          {capped
            ? t("oct5Core.noRecentTasksMatch", { count: AGENT_TASK_LIMIT })
            : t("oct5Core.s0259")}
        </PanelMessage>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((task) => <AgentTaskCard key={task.id} task={task} />)}
          {capped ? (
            <p className="px-1 text-xs text-muted-foreground">
              {t("oct5Core.recentTasks", { count: AGENT_TASK_LIMIT })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ArtifactKindIcon({ artifact }: { artifact: CompanyArtifact }) {
  useTranslation();
  const className = "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground";
  switch (artifact.mediaKind) {
    case "image": return <Image className={className} aria-hidden />;
    case "video": return <Video className={className} aria-hidden />;
    case "text":
    case "document": return <FileText className={className} aria-hidden />;
    default: return <File className={className} aria-hidden />;
  }
}

export function AgentArtifactCard({ artifact }: { artifact: CompanyArtifact }) {
  useTranslation();
  return (
    <Link
      // design-allow(card-pattern): navigation <Link> card; Card renders a div and would break anchor semantics
      to={artifact.href}
      disableIssueQuicklook
      target="_blank"
      rel="noreferrer"
      data-testid="agent-artifact-card"
      className={cardClassName}
    >
      <div className="flex min-w-0 items-start gap-2">
        <ArtifactKindIcon artifact={artifact} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={artifact.title}>
          {artifact.title}
        </span>
      </div>
      <div className="flex items-center gap-1.5 pl-6 text-xs text-muted-foreground">
        <span>{t("oct5Core.artifactUpdated", { date: formatDate(artifact.updatedAt) })}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{artifact.issue.identifier}</span>
      </div>
    </Link>
  );
}

/**
 * This agent's artifacts, newest first, filtered on the server. Pages are
 * capped so an unusually prolific agent can't stall the panel; the cap only
 * ever drops its oldest artifacts.
 */
async function listAgentArtifacts(companyId: string, agentId: string) {
  const artifacts: CompanyArtifact[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ARTIFACT_MAX_PAGES; page += 1) {
    const response = await artifactsApi.list(companyId, { agentId, limit: ARTIFACT_PAGE_SIZE, cursor });
    artifacts.push(...response.artifacts);
    if (!response.nextCursor) return { artifacts, truncated: false };
    cursor = response.nextCursor;
  }
  return { artifacts, truncated: true };
}

export function AgentArtifactsPanel({ companyId, agentId }: { companyId: string; agentId: string }) {
  useTranslation();
  const artifactsQuery = useQuery({
    queryKey: queryKeys.artifacts.byAgent(companyId, agentId),
    queryFn: () => listAgentArtifacts(companyId, agentId),
  });

  if (artifactsQuery.isPending) return <PanelMessage>{t("oct5Core.s0260")}</PanelMessage>;
  if (artifactsQuery.isError) return <PanelMessage tone="error">{t("oct5Core.s0261")}</PanelMessage>;
  const { artifacts, truncated } = artifactsQuery.data;
  if (artifacts.length === 0) return <PanelMessage>{t("oct5Core.s0262")}</PanelMessage>;
  return (
    <section className="flex flex-col gap-2" aria-label={t("oct5Core.s0263")}>
      {artifacts.map((artifact) => <AgentArtifactCard key={artifact.id} artifact={artifact} />)}
      {truncated ? (
        <p className="px-1 text-xs text-muted-foreground">{t("oct5Core.recentAgentArtifacts", { count: artifacts.length })}</p>
      ) : null}
    </section>
  );
}
