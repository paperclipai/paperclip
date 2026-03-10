import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BRIEFING_RECORD_KINDS,
  PLAN_RECORD_KINDS,
  RESULT_RECORD_KINDS,
  type Agent,
  type AnyRecord,
  type ExecutiveDecisionItem,
  type PortfolioSummary,
  type Project,
  type RecordScopeType,
} from "@paperclipai/shared";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { recordsApi } from "../api/records";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents, formatDateTime, formatTokens, projectUrl, relativeTime } from "../lib/utils";
import { FolderKanban, Sparkles } from "lucide-react";

type BriefingsMode = "board" | "briefings" | "results" | "plans" | "portfolio";
type WindowPreset = "last_visit" | "24h" | "7d";
type ComposerCategory = "plan" | "result" | "briefing";

interface RecordComposerProps {
  category: ComposerCategory;
  companyId: string;
  projects: Project[];
  agents: Agent[];
  kindOptions: readonly string[];
  submitLabel: string;
  submitting: boolean;
  defaultKind: string;
  defaultScopeType?: RecordScopeType;
  defaultScopeRefId?: string;
  onSubmit: (payload: {
    kind: string;
    scopeType: RecordScopeType;
    scopeRefId: string;
    title: string;
    summary?: string | null;
    bodyMd?: string | null;
    ownerAgentId?: string | null;
    decisionNeeded?: boolean;
    decisionDueAt?: string | null;
    healthStatus?: string | null;
    healthDelta?: string | null;
    confidence?: number | null;
  }) => void;
}

function toWindowSinceValue(preset: WindowPreset): string {
  if (preset === "last_visit") return "last_visit";
  const now = Date.now();
  const offset = preset === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(now - offset).toISOString();
}

function healthBadgeClass(status: string | null | undefined) {
  if (status === "green") return "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300";
  if (status === "yellow") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "red") return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

function recordScopeLabel(record: AnyRecord, projects: Project[], agents: Agent[]) {
  if (record.scopeType === "company") return "Company";
  if (record.scopeType === "project") {
    return projects.find((project) => project.id === record.scopeRefId)?.name ?? "Project";
  }
  return agents.find((agent) => agent.id === record.scopeRefId)?.name ?? "Agent";
}

function resolveScopeRefId(
  scopeType: RecordScopeType,
  companyId: string,
  projectId: string,
  agentId: string,
) {
  if (scopeType === "company") return companyId;
  if (scopeType === "project") return projectId;
  return agentId;
}

function BriefingTabs({ mode }: { mode: BriefingsMode }) {
  const tabs: Array<{ mode: BriefingsMode; label: string; href: string }> = [
    { mode: "board", label: "Board", href: "/briefings/board" },
    { mode: "briefings", label: "Briefings", href: "/briefings/briefings" },
    { mode: "results", label: "Results", href: "/briefings/results" },
    { mode: "plans", label: "Plans", href: "/briefings/plans" },
    { mode: "portfolio", label: "Portfolio", href: "/briefings/portfolio" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {tabs.map((tab) => (
        <Link
          key={tab.mode}
          to={tab.href}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            tab.mode === mode
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

function RecordComposer({
  category,
  companyId,
  projects,
  agents,
  kindOptions,
  submitLabel,
  submitting,
  defaultKind,
  defaultScopeType = "company",
  defaultScopeRefId,
  onSubmit,
}: RecordComposerProps) {
  // Keep one reusable editor for plans, results, and briefings so the executive
  // surface cannot drift into three incompatible creation flows.
  const [kind, setKind] = useState(defaultKind);
  const [scopeType, setScopeType] = useState<RecordScopeType>(defaultScopeType);
  const [projectId, setProjectId] = useState(defaultScopeType === "project" ? defaultScopeRefId ?? projects[0]?.id ?? "" : projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState(defaultScopeType === "agent" ? defaultScopeRefId ?? agents[0]?.id ?? "" : agents[0]?.id ?? "");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [decisionNeeded, setDecisionNeeded] = useState(false);
  const [decisionDueAt, setDecisionDueAt] = useState("");
  const [healthStatus, setHealthStatus] = useState("");
  const [healthDelta, setHealthDelta] = useState("");
  const [confidence, setConfidence] = useState("");

  useEffect(() => {
    if (!projects.length || projectId) return;
    setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!agents.length || agentId) return;
    setAgentId(agents[0]!.id);
  }, [agents, agentId]);

  function resetForm() {
    setKind(defaultKind);
    setScopeType(defaultScopeType);
    setProjectId(defaultScopeType === "project" ? defaultScopeRefId ?? projects[0]?.id ?? "" : projects[0]?.id ?? "");
    setAgentId(defaultScopeType === "agent" ? defaultScopeRefId ?? agents[0]?.id ?? "" : agents[0]?.id ?? "");
    setOwnerAgentId("");
    setTitle("");
    setSummary("");
    setBodyMd("");
    setDecisionNeeded(false);
    setDecisionDueAt("");
    setHealthStatus("");
    setHealthDelta("");
    setConfidence("");
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scopeRefId = resolveScopeRefId(scopeType, companyId, projectId, agentId);
    if (!scopeRefId) return;
    onSubmit({
      kind,
      scopeType,
      scopeRefId,
      title: title.trim(),
      summary: summary.trim() || null,
      bodyMd: bodyMd.trim() || null,
      ownerAgentId: ownerAgentId || null,
      decisionNeeded: category === "plan" ? decisionNeeded : undefined,
      decisionDueAt: category === "plan" && decisionDueAt ? new Date(decisionDueAt).toISOString() : null,
      healthStatus: category !== "briefing" ? healthStatus || null : undefined,
      healthDelta: category !== "briefing" ? healthDelta || null : undefined,
      confidence: category !== "briefing" && confidence ? Number(confidence) : null,
    });
    resetForm();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Create {category}</h3>
          <p className="text-xs text-muted-foreground">
            {category === "plan"
              ? "Capture decision records, operating plans, and risk registers before the work starts."
              : category === "result"
                ? "Publish durable outcomes and findings that should survive beyond issue threads."
                : "Create a draft briefing, then generate and publish it from the detail view."}
          </p>
        </div>
        <Badge variant="outline">Draft</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {kindOptions.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Owner</span>
          <select
            value={ownerAgentId}
            onChange={(event) => setOwnerAgentId(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Scope</span>
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value as RecordScopeType)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="company">Company</option>
            <option value="project">Project</option>
            <option value="agent">Executive owner</option>
          </select>
        </label>
        {scopeType === "project" ? (
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {projects.length === 0 ? <option value="">No projects</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : scopeType === "agent" ? (
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Executive owner</span>
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {agents.length === 0 ? <option value="">No agents</option> : null}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            Company-scoped record for the active company.
          </div>
        )}
      </div>

      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">Title</span>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Board-ready headline" required />
      </label>

      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">Summary</span>
        <Textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="Why this matters in one paragraph"
          rows={3}
        />
      </label>

      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">Body</span>
        <Textarea
          value={bodyMd}
          onChange={(event) => setBodyMd(event.target.value)}
          placeholder="Details, context, and evidence in Markdown"
          rows={8}
        />
      </label>

      {category === "plan" ? (
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Decision due</span>
            <Input type="datetime-local" value={decisionDueAt} onChange={(event) => setDecisionDueAt(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Health</span>
            <select
              value={healthStatus}
              onChange={(event) => setHealthStatus(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Unset</option>
              <option value="green">Green</option>
              <option value="yellow">Yellow</option>
              <option value="red">Red</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Trend</span>
            <select
              value={healthDelta}
              onChange={(event) => setHealthDelta(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Unset</option>
              <option value="up">Up</option>
              <option value="flat">Flat</option>
              <option value="down">Down</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="col-span-full flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={decisionNeeded}
              onChange={(event) => setDecisionNeeded(event.target.checked)}
              className="h-4 w-4"
            />
            <span>Flag this as a decision the board needs to make.</span>
          </label>
        </div>
      ) : null}

      {category === "result" ? (
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Health</span>
            <select
              value={healthStatus}
              onChange={(event) => setHealthStatus(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Unset</option>
              <option value="green">Green</option>
              <option value="yellow">Yellow</option>
              <option value="red">Red</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Trend</span>
            <select
              value={healthDelta}
              onChange={(event) => setHealthDelta(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Unset</option>
              <option value="up">Up</option>
              <option value="flat">Flat</option>
              <option value="down">Down</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Confidence</span>
            <Input
              type="number"
              min={0}
              max={100}
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
              placeholder="0-100"
            />
          </label>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={submitting || title.trim().length === 0}>
          {submitting ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function RecordList({
  records,
  projects,
  agents,
  emptyMessage,
}: {
  records: AnyRecord[];
  projects: Project[];
  agents: Agent[];
  emptyMessage: string;
}) {
  if (records.length === 0) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-3">
      {records.map((record) => (
        <Link
          key={record.id}
          to={`/briefings/records/${record.id}`}
          className="block rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/20"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{record.title}</h3>
                <Badge variant="outline">{record.kind.replace(/_/g, " ")}</Badge>
                <Badge variant="outline">{record.status.replace(/_/g, " ")}</Badge>
                {record.healthStatus ? (
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", healthBadgeClass(record.healthStatus))}>
                    {record.healthStatus}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">{record.summary ?? "No summary yet."}</p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>{recordScopeLabel(record, projects, agents)}</div>
              <div>Updated {relativeTime(record.updatedAt)}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function BoardSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-4 space-y-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function BoardRecordList({
  records,
  emptyMessage,
}: {
  records: Array<AnyRecord | ExecutiveDecisionItem>;
  emptyMessage: string;
}) {
  if (records.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-3">
      {records.map((record) => (
        "sourceType" in record ? (
          <Link
            key={record.id}
            to={record.sourceType === "plan" ? `/briefings/records/${record.plan.id}` : `/approvals/${record.approval.id}`}
            className="block rounded-xl border border-border/70 bg-background px-4 py-3 transition-colors hover:bg-accent/20"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{record.title}</span>
                  <Badge variant="outline">{record.sourceType === "plan" ? "decision record" : "approval"}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{record.summary ?? "No summary yet."}</p>
              </div>
              <span className="text-xs text-muted-foreground">{record.dueAt ? relativeTime(record.dueAt) : "No due date"}</span>
            </div>
          </Link>
        ) : (
        <Link
          key={record.id}
          to={`/briefings/records/${record.id}`}
          className="block rounded-xl border border-border/70 bg-background px-4 py-3 transition-colors hover:bg-accent/20"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{record.title}</span>
                <Badge variant="outline">{record.kind.replace(/_/g, " ")}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{record.summary ?? "No summary yet."}</p>
            </div>
            <span className="text-xs text-muted-foreground">{relativeTime(record.publishedAt ?? record.updatedAt)}</span>
          </div>
        </Link>
        )
      ))}
    </div>
  );
}

function BoardView({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[];
  agents: Agent[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showComposer, setShowComposer] = useState(false);
  const scopeType = (searchParams.get("scopeType") as RecordScopeType | null) ?? "company";
  const scopeId = searchParams.get("scopeId") ?? "";
  const windowPreset = (searchParams.get("window") as WindowPreset | null) ?? "last_visit";
  const effectiveScopeId = scopeType === "company" ? companyId : scopeId;

  const boardQuery = useQuery({
    queryKey: queryKeys.records.board(companyId, scopeType, effectiveScopeId || companyId, windowPreset),
    queryFn: () =>
      recordsApi.boardSummary(companyId, {
        scopeType,
        scopeId: scopeType === "company" ? undefined : effectiveScopeId,
        since: toWindowSinceValue(windowPreset),
      }),
    enabled: scopeType === "company" || Boolean(effectiveScopeId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const createBriefingMutation = useMutation({
    mutationFn: (payload: Parameters<typeof recordsApi.createBriefing>[1]) => recordsApi.createBriefing(companyId, payload),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: ["records", companyId] });
      navigate(`/briefings/records/${record.id}`);
    },
  });

  function updateScope(nextScopeType: RecordScopeType, nextScopeId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("scopeType", nextScopeType);
    if (nextScopeType === "company") next.delete("scopeId");
    else if (nextScopeId) next.set("scopeId", nextScopeId);
    else next.delete("scopeId");
    setSearchParams(next);
  }

  function updateWindow(nextWindow: WindowPreset) {
    const next = new URLSearchParams(searchParams);
    next.set("window", nextWindow);
    setSearchParams(next);
  }

  const board = boardQuery.data;
  const activeScopeLabel =
    scopeType === "company"
      ? "Company"
      : scopeType === "project"
        ? projects.find((project) => project.id === effectiveScopeId)?.name ?? "Project"
        : agents.find((agent) => agent.id === effectiveScopeId)?.name ?? "Executive owner";

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{activeScopeLabel}</Badge>
              <Badge variant="outline">
                {board?.since ? `Since ${formatDateTime(board.since)}` : windowPreset === "last_visit" ? "Since your last visit" : "Open time window"}
              </Badge>
              {board?.lastViewedAt ? <span className="text-xs text-muted-foreground">Last viewed {relativeTime(board.lastViewedAt)}</span> : null}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-foreground">Executive results board</h2>
              <p className="text-sm text-muted-foreground">
                What landed, what is blocked, what decision is required, and where cost behavior looks wrong.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setShowComposer((current) => !current)}>
              {showComposer ? "Hide briefing draft" : "Create briefing draft"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select
              value={scopeType}
              onChange={(event) => updateScope(event.target.value as RecordScopeType, "")}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="company">Company</option>
              <option value="project">Project</option>
              <option value="agent">Executive owner</option>
            </select>
          </label>
          {scopeType === "project" ? (
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Project</span>
              <select
                value={effectiveScopeId}
                onChange={(event) => updateScope("project", event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : scopeType === "agent" ? (
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Executive owner</span>
              <select
                value={effectiveScopeId}
                onChange={(event) => updateScope("agent", event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select an executive owner</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              Board rollup for the full company.
            </div>
          )}
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Window</span>
            <select
              value={windowPreset}
              onChange={(event) => updateWindow(event.target.value as WindowPreset)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="last_visit">Since last visit</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </label>
        </div>
      </section>

      {showComposer ? (
        <RecordComposer
          category="briefing"
          companyId={companyId}
          projects={projects}
          agents={agents}
          kindOptions={BRIEFING_RECORD_KINDS}
          submitLabel="Create briefing draft"
          submitting={createBriefingMutation.isPending}
          defaultKind="weekly_briefing"
          defaultScopeType={scopeType}
          defaultScopeRefId={effectiveScopeId || companyId}
          onSubmit={(payload) => {
            createBriefingMutation.mutate({
              kind: payload.kind as (typeof BRIEFING_RECORD_KINDS)[number],
              scopeType: payload.scopeType,
              scopeRefId: payload.scopeRefId,
              title: payload.title,
              summary: payload.summary,
              bodyMd: payload.bodyMd,
              ownerAgentId: payload.ownerAgentId,
            });
          }}
        />
      ) : null}

      {boardQuery.isLoading ? <PageSkeleton variant="dashboard" /> : null}
      {boardQuery.error ? <p className="text-sm text-destructive">{boardQuery.error.message}</p> : null}

      {board ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <BoardSection
            title="Outcomes landed"
            subtitle="Published results since the selected window."
          >
            <BoardRecordList records={board.outcomesLanded} emptyMessage="No published outcomes in this window." />
          </BoardSection>

          <BoardSection
            title="Risks and blocks"
            subtitle="Open risk registers and published blockers that need attention."
          >
            <BoardRecordList records={board.risksAndBlocks} emptyMessage="No active risks or blockers." />
          </BoardSection>

          <BoardSection
            title="Decisions needed"
            subtitle="Decision records that are still waiting on an executive call."
          >
            <BoardRecordList records={board.decisionsNeeded} emptyMessage="No active executive decisions." />
          </BoardSection>

          <BoardSection
            title="Executive rollups"
            subtitle="Latest published rollup per executive owner."
          >
            <BoardRecordList records={board.executiveRollups} emptyMessage="No executive rollups have been published yet." />
          </BoardSection>

          <BoardSection
            title="Project health"
            subtitle="Portfolio health with latest result, blocker, and next decision." 
          >
            <div className="space-y-3">
              {board.projectHealth.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matching projects in this scope.</p>
              ) : (
                board.projectHealth.map((project) => (
                  <div key={project.projectId} className="rounded-xl border border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={projectUrl({ id: project.projectId, name: project.projectName, urlKey: project.projectId })} className="text-sm font-medium text-foreground hover:underline">
                            {project.projectName}
                          </Link>
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", healthBadgeClass(project.healthStatus))}>
                            {project.healthStatus}
                          </span>
                          <Badge variant="outline">{project.healthDelta}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{project.currentBlocker ?? project.lastMeaningfulResult?.summary ?? "No major exceptions recorded."}</p>
                      </div>
                      <div className="space-y-1 text-right text-xs text-muted-foreground">
                        <div>Status: {project.projectStatus.replace(/_/g, " ")}</div>
                        <div>Confidence: {project.confidence == null ? "n/a" : `${project.confidence}%`}</div>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                      <div>
                        Last result:{" "}
                        {project.lastMeaningfulResult ? (
                          <Link to={`/briefings/records/${project.lastMeaningfulResult.id}`} className="text-foreground hover:underline">
                            {project.lastMeaningfulResult.title}
                          </Link>
                        ) : (
                          "None"
                        )}
                      </div>
                      <div>
                        Next decision:{" "}
                        {project.nextDecision ? (
                          <Link to={`/briefings/records/${project.nextDecision.id}`} className="text-foreground hover:underline">
                            {project.nextDecision.title}
                          </Link>
                        ) : (
                          "None"
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </BoardSection>

          <BoardSection
            title="Cost and token anomalies"
            subtitle="Runs with unusually high token usage or unpriced spend data."
          >
            <div className="space-y-3">
              {board.costAnomalies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No cost anomalies detected.</p>
              ) : (
                board.costAnomalies.map((anomaly) => (
                  <div key={anomaly.runId} className="rounded-xl border border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {anomaly.agentId ? (
                            <Link to={`/agents/${anomaly.agentId}/runs/${anomaly.runId}`} className="text-sm font-medium text-foreground hover:underline">
                              {anomaly.agentName ?? anomaly.runId.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium text-foreground">{anomaly.runId.slice(0, 8)}</span>
                          )}
                          <Badge variant="outline">{anomaly.pricingState}</Badge>
                          {anomaly.projectName ? <Badge variant="outline">{anomaly.projectName}</Badge> : null}
                        </div>
                        <p className="text-sm text-muted-foreground">{anomaly.reason}</p>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{formatTokens(anomaly.inputTokens + anomaly.outputTokens)} tokens</div>
                        <div>{anomaly.pricedCostCents == null ? "Cost unknown" : formatCents(anomaly.pricedCostCents)}</div>
                        <div>{anomaly.occurredAt ? relativeTime(anomaly.occurredAt) : "recent"}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </BoardSection>
        </div>
      ) : null}
    </div>
  );
}

function BriefingLibraryView({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[];
  agents: Agent[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showComposer, setShowComposer] = useState(false);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [scopeRefId, setScopeRefId] = useState("");

  const filters = useMemo(
    () => ({
      kind: kind || undefined,
      status: status || undefined,
      projectId: projectId || undefined,
      scopeType: scopeType || undefined,
      scopeRefId: scopeType ? scopeRefId || undefined : undefined,
    }),
    [kind, status, projectId, scopeType, scopeRefId],
  );

  const briefingsQuery = useQuery({
    queryKey: queryKeys.records.briefings(companyId, filters),
    queryFn: () => recordsApi.listBriefings(companyId, filters),
  });

  const createBriefingMutation = useMutation({
    mutationFn: (payload: Parameters<typeof recordsApi.createBriefing>[1]) => recordsApi.createBriefing(companyId, payload),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: ["records", companyId] });
      navigate(`/briefings/records/${record.id}`);
    },
  });

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Briefing library</h2>
            <p className="text-sm text-muted-foreground">
              Daily briefs, weekly rollups, project status reports, incident summaries, and board packets.
            </p>
          </div>
          <Button variant="outline" onClick={() => setShowComposer((current) => !current)}>
            {showComposer ? "Hide composer" : "New briefing"}
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Kind</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All kinds</option>
              {BRIEFING_RECORD_KINDS.map((option) => (
                <option key={option} value={option}>{option.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select value={scopeType} onChange={(event) => { setScopeType(event.target.value); setScopeRefId(""); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All scopes</option>
              <option value="company">Company</option>
              <option value="project">Project</option>
              <option value="agent">Executive owner</option>
            </select>
          </label>
        </div>

        {scopeType === "project" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {scopeType === "agent" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All executive owners</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {showComposer ? (
        <RecordComposer
          category="briefing"
          companyId={companyId}
          projects={projects}
          agents={agents}
          kindOptions={BRIEFING_RECORD_KINDS}
          submitLabel="Create briefing"
          submitting={createBriefingMutation.isPending}
          defaultKind="weekly_briefing"
          onSubmit={(payload) => {
            createBriefingMutation.mutate({
              kind: payload.kind as (typeof BRIEFING_RECORD_KINDS)[number],
              scopeType: payload.scopeType,
              scopeRefId: payload.scopeRefId,
              title: payload.title,
              summary: payload.summary,
              bodyMd: payload.bodyMd,
              ownerAgentId: payload.ownerAgentId,
            });
          }}
        />
      ) : null}

      {briefingsQuery.isLoading ? <PageSkeleton variant="list" /> : null}
      {briefingsQuery.error ? <p className="text-sm text-destructive">{briefingsQuery.error.message}</p> : null}
      {briefingsQuery.data ? (
        <RecordList records={briefingsQuery.data} projects={projects} agents={agents} emptyMessage="No briefings match these filters." />
      ) : null}
    </div>
  );
}

function PortfolioView({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[];
  agents: Agent[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const scopeType = (searchParams.get("scopeType") as RecordScopeType | null) ?? "company";
  const scopeId = searchParams.get("scopeId") ?? "";
  const effectiveScopeId = scopeType === "company" ? companyId : scopeId;

  const portfolioQuery = useQuery({
    queryKey: queryKeys.records.portfolio(companyId, scopeType, effectiveScopeId || companyId),
    queryFn: () => recordsApi.portfolioSummary(companyId, {
      scopeType,
      scopeId: scopeType === "company" ? undefined : effectiveScopeId,
    }),
    enabled: scopeType === "company" || Boolean(effectiveScopeId),
  });

  function updateScope(nextScopeType: RecordScopeType, nextScopeId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("scopeType", nextScopeType);
    if (nextScopeType === "company") next.delete("scopeId");
    else if (nextScopeId) next.set("scopeId", nextScopeId);
    else next.delete("scopeId");
    setSearchParams(next);
  }

  const portfolio: PortfolioSummary | undefined = portfolioQuery.data;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Portfolio board</h2>
            <p className="text-sm text-muted-foreground">
              Health, milestone status, current blocker, next decision, and budget truthfulness across projects.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select
              value={scopeType}
              onChange={(event) => updateScope(event.target.value as RecordScopeType, "")}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="company">Company</option>
              <option value="project">Project</option>
              <option value="agent">Executive owner</option>
            </select>
          </label>
          {scopeType === "project" ? (
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Project</span>
              <select value={effectiveScopeId} onChange={(event) => updateScope("project", event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Select a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
          ) : scopeType === "agent" ? (
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Executive owner</span>
              <select value={effectiveScopeId} onChange={(event) => updateScope("agent", event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Select an executive owner</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              Portfolio rollup for the active company.
            </div>
          )}
        </div>
      </section>

      {portfolioQuery.isLoading ? <PageSkeleton variant="list" /> : null}
      {portfolioQuery.error ? <p className="text-sm text-destructive">{portfolioQuery.error.message}</p> : null}
      {portfolio ? (
        <div className="space-y-3">
          {portfolio.projects.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No portfolio rows exist in this scope yet.
            </p>
          ) : (
            portfolio.projects.map((project) => (
              <div key={project.projectId} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={projectUrl({ id: project.projectId, name: project.projectName, urlKey: project.projectId })} className="text-base font-semibold text-foreground hover:underline">
                        {project.projectName}
                      </Link>
                      <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", healthBadgeClass(project.healthStatus))}>
                        {project.healthStatus}
                      </span>
                      <Badge variant="outline">{project.healthDelta}</Badge>
                      <Badge variant="outline">{project.budgetPricingState}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {project.currentBlocker ?? "No blocker recorded."}
                    </p>
                  </div>
                  <div className="grid gap-2 text-right text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <div>Lead</div>
                      <div className="font-medium text-foreground">{project.leadAgentName ?? "Unassigned"}</div>
                    </div>
                    <div>
                      <div>Budget burn</div>
                      <div className="font-medium text-foreground">
                        {project.budgetPricingState === "unpriced" ? "Unpriced usage" : formatCents(project.budgetBurn)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                    <div className="text-xs text-muted-foreground">Milestone status</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{project.milestoneStatus}</div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                    <div className="text-xs text-muted-foreground">Next board decision</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{project.nextBoardDecision?.title ?? "None"}</div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                    <div className="text-xs text-muted-foreground">Last meaningful result</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{project.lastMeaningfulResult?.title ?? "None"}</div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                    <div className="text-xs text-muted-foreground">Confidence</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{project.confidence == null ? "n/a" : `${project.confidence}%`}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ResultsView({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[];
  agents: Agent[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showComposer, setShowComposer] = useState(false);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [scopeRefId, setScopeRefId] = useState("");

  const filters = useMemo(
    () => ({
      kind: kind || undefined,
      status: status || undefined,
      projectId: projectId || undefined,
      scopeType: scopeType || undefined,
      scopeRefId: scopeType ? scopeRefId || undefined : undefined,
    }),
    [kind, status, projectId, scopeType, scopeRefId],
  );

  const resultsQuery = useQuery({
    queryKey: queryKeys.records.results(companyId, filters),
    queryFn: () => recordsApi.listResults(companyId, filters),
  });

  const createResultMutation = useMutation({
    mutationFn: (payload: Parameters<typeof recordsApi.createResult>[1]) => recordsApi.createResult(companyId, payload),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: ["records", companyId] });
      navigate(`/briefings/records/${record.id}`);
    },
  });

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Results library</h2>
            <p className="text-sm text-muted-foreground">
              Durable deliverables, findings, blockers, and status reports that should survive the execution thread.
            </p>
          </div>
          <Button variant="outline" onClick={() => setShowComposer((current) => !current)}>
            {showComposer ? "Hide composer" : "New result"}
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Kind</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All kinds</option>
              {RESULT_RECORD_KINDS.map((option) => (
                <option key={option} value={option}>{option.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select value={scopeType} onChange={(event) => { setScopeType(event.target.value); setScopeRefId(""); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All scopes</option>
              <option value="company">Company</option>
              <option value="project">Project</option>
              <option value="agent">Executive owner</option>
            </select>
          </label>
        </div>

        {scopeType === "project" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {scopeType === "agent" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All executive owners</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {showComposer ? (
        <RecordComposer
          category="result"
          companyId={companyId}
          projects={projects}
          agents={agents}
          kindOptions={RESULT_RECORD_KINDS}
          submitLabel="Create result"
          submitting={createResultMutation.isPending}
          defaultKind="status_report"
          onSubmit={(payload) => {
            createResultMutation.mutate({
              kind: payload.kind as (typeof RESULT_RECORD_KINDS)[number],
              scopeType: payload.scopeType,
              scopeRefId: payload.scopeRefId,
              title: payload.title,
              summary: payload.summary,
              bodyMd: payload.bodyMd,
              ownerAgentId: payload.ownerAgentId,
              healthStatus: payload.healthStatus as "green" | "yellow" | "red" | "unknown" | null | undefined,
              healthDelta: payload.healthDelta as "up" | "flat" | "down" | "unknown" | null | undefined,
              confidence: payload.confidence,
            });
          }}
        />
      ) : null}

      {resultsQuery.isLoading ? <PageSkeleton variant="list" /> : null}
      {resultsQuery.error ? <p className="text-sm text-destructive">{resultsQuery.error.message}</p> : null}
      {resultsQuery.data ? (
        <RecordList records={resultsQuery.data} projects={projects} agents={agents} emptyMessage="No results match these filters." />
      ) : null}
    </div>
  );
}

function PlansView({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[];
  agents: Agent[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showComposer, setShowComposer] = useState(false);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [scopeRefId, setScopeRefId] = useState("");

  const filters = useMemo(
    () => ({
      kind: kind || undefined,
      status: status || undefined,
      projectId: projectId || undefined,
      scopeType: scopeType || undefined,
      scopeRefId: scopeType ? scopeRefId || undefined : undefined,
    }),
    [kind, status, projectId, scopeType, scopeRefId],
  );

  const plansQuery = useQuery({
    queryKey: queryKeys.records.plans(companyId, filters),
    queryFn: () => recordsApi.listPlans(companyId, filters),
  });

  const createPlanMutation = useMutation({
    mutationFn: (payload: Parameters<typeof recordsApi.createPlan>[1]) => recordsApi.createPlan(companyId, payload),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: ["records", companyId] });
      navigate(`/briefings/records/${record.id}`);
    },
  });

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Planning library</h2>
            <p className="text-sm text-muted-foreground">
              Strategy memos, operating plans, decision records, and risk registers that exist before task decomposition.
            </p>
          </div>
          <Button variant="outline" onClick={() => setShowComposer((current) => !current)}>
            {showComposer ? "Hide composer" : "New plan"}
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Kind</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All kinds</option>
              {PLAN_RECORD_KINDS.map((option) => (
                <option key={option} value={option}>{option.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select value={scopeType} onChange={(event) => { setScopeType(event.target.value); setScopeRefId(""); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All scopes</option>
              <option value="company">Company</option>
              <option value="project">Project</option>
              <option value="agent">Executive owner</option>
            </select>
          </label>
        </div>

        {scopeType === "project" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {scopeType === "agent" ? (
          <div className="mt-3">
            <select value={scopeRefId} onChange={(event) => setScopeRefId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All executive owners</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {showComposer ? (
        <RecordComposer
          category="plan"
          companyId={companyId}
          projects={projects}
          agents={agents}
          kindOptions={PLAN_RECORD_KINDS}
          submitLabel="Create plan"
          submitting={createPlanMutation.isPending}
          defaultKind="project_brief"
          onSubmit={(payload) => {
            createPlanMutation.mutate({
              kind: payload.kind as (typeof PLAN_RECORD_KINDS)[number],
              scopeType: payload.scopeType,
              scopeRefId: payload.scopeRefId,
              title: payload.title,
              summary: payload.summary,
              bodyMd: payload.bodyMd,
              ownerAgentId: payload.ownerAgentId,
              decisionNeeded: payload.decisionNeeded,
              decisionDueAt: payload.decisionDueAt,
              healthStatus: payload.healthStatus as "green" | "yellow" | "red" | "unknown" | null | undefined,
              healthDelta: payload.healthDelta as "up" | "flat" | "down" | "unknown" | null | undefined,
            });
          }}
        />
      ) : null}

      {plansQuery.isLoading ? <PageSkeleton variant="list" /> : null}
      {plansQuery.error ? <p className="text-sm text-destructive">{plansQuery.error.message}</p> : null}
      {plansQuery.data ? (
        <RecordList records={plansQuery.data} projects={projects} agents={agents} emptyMessage="No plans match these filters." />
      ) : null}
    </div>
  );
}

export function Briefings({ mode }: { mode: BriefingsMode }) {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    const detail =
      mode === "board"
        ? "Board"
        : mode === "briefings"
          ? "Briefings"
          : mode === "results"
            ? "Results"
            : mode === "portfolio"
              ? "Portfolio"
              : "Plans";
    setBreadcrumbs([{ label: "Briefings", href: "/briefings/board" }, { label: detail }]);
  }, [mode, setBreadcrumbs]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return <EmptyState icon={FolderKanban} message="Create a company before opening the executive briefing surface." />;
    }
    return <EmptyState icon={FolderKanban} message="Select a company to open executive briefings." />;
  }

  const projects = projectsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(15,23,42,0.05),transparent_45%),linear-gradient(135deg,rgba(255,255,255,0.02),rgba(15,23,42,0.04))] p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm">Executive layer</span>
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Briefings, results, and plans</h1>
              <p className="max-w-3xl text-sm text-muted-foreground">
                Keep the telemetry dashboard narrow. Use this surface for interpretation, durable outputs, and decisions that need a human call.
              </p>
            </div>
          </div>
          <BriefingTabs mode={mode} />
        </div>
      </section>

      {projectsQuery.error ? <p className="text-sm text-destructive">{projectsQuery.error.message}</p> : null}
      {agentsQuery.error ? <p className="text-sm text-destructive">{agentsQuery.error.message}</p> : null}

      {mode === "board" ? <BoardView companyId={selectedCompanyId} projects={projects} agents={agents} /> : null}
      {mode === "briefings" ? <BriefingLibraryView companyId={selectedCompanyId} projects={projects} agents={agents} /> : null}
      {mode === "results" ? <ResultsView companyId={selectedCompanyId} projects={projects} agents={agents} /> : null}
      {mode === "plans" ? <PlansView companyId={selectedCompanyId} projects={projects} agents={agents} /> : null}
      {mode === "portfolio" ? <PortfolioView companyId={selectedCompanyId} projects={projects} agents={agents} /> : null}
    </div>
  );
}
