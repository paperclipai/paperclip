// LET-506 phase-4 — Multica-pattern EAOS agent detail surface.
//
// This is a customer-shell read-only inspector/overview page, not the legacy
// Kernel agent configuration page. It mirrors the Multica reference shape
// (left inspector column + right activity/configuration overview) while keeping
// Paperclip's backend-backed data and role-safety contract: no pause/resume,
// approve/terminate, key creation, wakeup, or live runtime mutation controls.

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Clock3,
  KeyRound,
  ListTodo,
  Network,
  ShieldCheck,
  Sparkles,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import {
  AGENT_ROLE_LABELS,
  type Agent,
  type AgentDetail,
  type AgentRuntimeState,
  type AgentSkillSnapshot,
  type AgentTaskSession,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useParams } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import { redactSecretLikeText, safeDisplayText } from "../secret-redact";
import { AgentAvatar } from "./AgentAvatar";
import { humanizeAdapterType, humanizeAgentStatus } from "./agent-roster";

interface AgentDetailPageProps {
  now?: Date;
}

export function AgentDetailPage({ now }: AgentDetailPageProps = {}) {
  const { agentRef } = useParams<{ agentRef?: string }>();
  const { selectedCompanyId } = useCompany();
  const trimmedRef = agentRef?.trim() ?? "";
  const referenceNow = now ?? new Date();

  const agentQuery = useQuery({
    queryKey: selectedCompanyId && trimmedRef
      ? [...queryKeys.agents.detail(trimmedRef), selectedCompanyId, "eaos-detail"]
      : ["agents", "detail", "__no-agent__", selectedCompanyId ?? "__no-company__", "eaos-detail"],
    queryFn: () => agentsApi.get(trimmedRef, selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && trimmedRef),
    retry: false,
    staleTime: 30_000,
  });

  const agent = agentQuery.data ?? null;
  const agentId = agent?.id ?? null;

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__no-company__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
    staleTime: 60_000,
  });

  const runtimeQuery = useQuery({
    queryKey: agentId ? [...queryKeys.agents.runtimeState(agentId), "eaos-detail"] : ["agents", "runtime-state", "__none__", "eaos-detail"],
    queryFn: () => agentsApi.runtimeState(agentId!, selectedCompanyId!),
    enabled: Boolean(agentId && selectedCompanyId),
    retry: false,
    staleTime: 10_000,
  });

  const taskSessionsQuery = useQuery({
    queryKey: agentId ? [...queryKeys.agents.taskSessions(agentId), "eaos-detail"] : ["agents", "task-sessions", "__none__", "eaos-detail"],
    queryFn: () => agentsApi.taskSessions(agentId!, selectedCompanyId!),
    enabled: Boolean(agentId && selectedCompanyId),
    retry: false,
    staleTime: 30_000,
  });

  const skillsQuery = useQuery({
    queryKey: agentId ? [...queryKeys.agents.skills(agentId), "eaos-detail"] : ["agents", "skills", "__none__", "eaos-detail"],
    queryFn: () => agentsApi.skills(agentId!, selectedCompanyId!),
    enabled: Boolean(agentId && selectedCompanyId),
    retry: false,
    staleTime: 60_000,
  });

  const allAgents = agentsQuery.data ?? [];
  const reportsTo = useMemo(
    () => (agent?.reportsTo ? allAgents.find((candidate) => candidate.id === agent.reportsTo) ?? null : null),
    [agent?.reportsTo, allAgents],
  );

  if (!selectedCompanyId) {
    return (
      <AgentDetailEmptyShell
        testId="eaos-agent-detail-no-company"
        title="No company scope selected"
        body="Select a company in the workspace switcher to inspect agents."
      />
    );
  }

  if (!trimmedRef) {
    return (
      <AgentDetailEmptyShell
        testId="eaos-agent-detail-invalid-ref"
        title="Agent reference is missing"
        body="The route did not provide an agent id or URL key."
      />
    );
  }

  if (agentQuery.isLoading) {
    return <AgentDetailLoading />;
  }

  if (agentQuery.isError || !agent) {
    return (
      <AgentDetailEmptyShell
        testId="eaos-agent-detail-not-found"
        title="Agent not found"
        body={`No backend agent matched “${redactSecretLikeText(trimmedRef)}”.`}
        onRetry={() => agentQuery.refetch()}
      />
    );
  }

  const safeAgentName = redactSecretLikeText(agent.name);

  return (
    <section
      aria-labelledby="eaos-agent-detail-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-agent-detail-page"
      data-agent-id={agent.id}
      data-eaos-data-connected="true"
    >
      <EaosPageHeader
        title={safeAgentName}
        breadcrumb={<Link to="/eaos/agents" className="hover:text-foreground">Agents</Link>}
        testId="eaos-agent-detail-page-header"
        actions={
          <Link
            to={`/agents/${encodeURIComponent(agent.id)}`}
            data-testid="eaos-agent-detail-kernel-link"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Kernel
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        }
      />
      <h1 id="eaos-agent-detail-title" className="sr-only" data-testid="eaos-agent-detail-title">
        {safeAgentName}
      </h1>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:px-8">
        <AgentInspector
          agent={agent}
          reportsTo={reportsTo}
          referenceNow={referenceNow}
          runtime={runtimeQuery.data ?? null}
        />
        <AgentOverview
          agent={agent}
          runtime={runtimeQuery.data ?? null}
          runtimeLoading={runtimeQuery.isLoading}
          sessions={taskSessionsQuery.data ?? []}
          sessionsLoading={taskSessionsQuery.isLoading}
          skills={skillsQuery.data ?? null}
          skillsLoading={skillsQuery.isLoading}
        />
      </div>
    </section>
  );
}

function AgentInspector({
  agent,
  reportsTo,
  referenceNow,
  runtime,
}: {
  agent: AgentDetail;
  reportsTo: Agent | null;
  referenceNow: Date;
  runtime: AgentRuntimeState | null;
}) {
  const roleLabel = AGENT_ROLE_LABELS[agent.role] ?? humanizeToken(agent.role);
  const title = safeDisplayText(agent.title, 120);
  return (
    <aside
      aria-label="Agent inspector"
      data-testid="eaos-agent-detail-inspector"
      className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex items-start gap-3 border-b border-border p-4">
        <AgentAvatar
          size="lg"
          subject={{ kind: "agent", agentId: agent.id, name: agent.name, role: agent.role }}
          ariaLabel={`${redactSecretLikeText(agent.name)} avatar`}
          testId="eaos-agent-detail-avatar"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground" data-testid="eaos-agent-detail-name">
            {redactSecretLikeText(agent.name)}
          </p>
          <p className="truncate text-xs text-muted-foreground" data-testid="eaos-agent-detail-role">
            {title ? `${title} · ${roleLabel}` : roleLabel}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <InspectorSection title="Status">
          <StatusPill agent={agent} />
          <PropertyRow label="Last seen" value={relativeOrNever(toDate(agent.lastHeartbeatAt), referenceNow)} />
          <PropertyRow label="Runtime" value={humanizeAdapterType(agent.adapterType)} />
          <PropertyRow label="Last run" value={runtime?.lastRunStatus ? humanizeToken(runtime.lastRunStatus) : "No run recorded"} />
        </InspectorSection>

        <InspectorSection title="Organization">
          <PropertyRow label="Reports to" value={reportsTo ? redactSecretLikeText(reportsTo.name) : "Company root"} />
          <PropertyRow label="Chain" value={`${agent.chainOfCommand.length} level${agent.chainOfCommand.length === 1 ? "" : "s"}`} />
          <PropertyRow label="Can create agents" value={agent.permissions.canCreateAgents ? "Yes" : "No"} />
          <PropertyRow label="Can assign tasks" value={agent.access.canAssignTasks ? "Yes" : "No"} />
        </InspectorSection>

        <InspectorSection title="Budget">
          <PropertyRow label="Monthly budget" value={formatUsdCents(agent.budgetMonthlyCents)} />
          <PropertyRow label="Spent this month" value={formatUsdCents(agent.spentMonthlyCents)} />
          <BudgetBar spent={agent.spentMonthlyCents} budget={agent.budgetMonthlyCents} />
        </InspectorSection>
      </div>
    </aside>
  );
}

function AgentOverview({
  agent,
  runtime,
  runtimeLoading,
  sessions,
  sessionsLoading,
  skills,
  skillsLoading,
}: {
  agent: AgentDetail;
  runtime: AgentRuntimeState | null;
  runtimeLoading: boolean;
  sessions: readonly AgentTaskSession[];
  sessionsLoading: boolean;
  skills: AgentSkillSnapshot | null;
  skillsLoading: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background" data-testid="eaos-agent-detail-overview">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overview</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <MetricCard icon={Bot} label="Identity" value={humanizeAgentStatus(agent.status)} detail={humanizeAdapterType(agent.adapterType)} />
          <MetricCard
            icon={WalletCards}
            label="Spend"
            value={formatUsdCents(agent.spentMonthlyCents)}
            detail={`of ${formatUsdCents(agent.budgetMonthlyCents)} monthly budget`}
          />
          <MetricCard
            icon={ListTodo}
            label="Sessions"
            value={sessionsLoading ? "Loading…" : String(sessions.length)}
            detail="Backend task sessions"
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <RuntimePanel runtime={runtime} loading={runtimeLoading} />
          <SkillsPanel skills={skills} loading={skillsLoading} />
          <ChainPanel chain={agent.chainOfCommand} />
          <SessionsPanel sessions={sessions} loading={sessionsLoading} />
        </div>
      </div>
    </div>
  );
}

function RuntimePanel({ runtime, loading }: { runtime: AgentRuntimeState | null; loading: boolean }) {
  return (
    <OverviewPanel title="Runtime" icon={Clock3} testId="eaos-agent-detail-runtime-panel">
      {loading ? (
        <PanelMuted>Loading runtime state…</PanelMuted>
      ) : !runtime ? (
        <PanelMuted>No runtime state recorded for this agent yet.</PanelMuted>
      ) : (
        <div className="space-y-2">
          <PropertyRow label="Session" value={runtime.sessionDisplayId ? redactSecretLikeText(runtime.sessionDisplayId) : runtime.sessionId ? redactSecretLikeText(runtime.sessionId) : "No active session"} />
          <PropertyRow label="Last run" value={runtime.lastRunStatus ? humanizeToken(runtime.lastRunStatus) : "No run recorded"} />
          <PropertyRow label="Input tokens" value={formatNumber(runtime.totalInputTokens + runtime.totalCachedInputTokens)} />
          <PropertyRow label="Output tokens" value={formatNumber(runtime.totalOutputTokens)} />
          <PropertyRow label="Total cost" value={formatUsdCents(runtime.totalCostCents)} />
          {runtime.lastError ? (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
              {safeDisplayText(runtime.lastError, 360)}
            </p>
          ) : null}
        </div>
      )}
    </OverviewPanel>
  );
}

function SkillsPanel({ skills, loading }: { skills: AgentSkillSnapshot | null; loading: boolean }) {
  const entries = skills?.entries ?? [];
  return (
    <OverviewPanel title="Skills" icon={Sparkles} testId="eaos-agent-detail-skills-panel">
      {loading ? (
        <PanelMuted>Loading skills…</PanelMuted>
      ) : !skills ? (
        <PanelMuted>No skills snapshot recorded.</PanelMuted>
      ) : !skills.supported ? (
        <PanelMuted>Skills are not supported by this runtime adapter.</PanelMuted>
      ) : entries.length === 0 ? (
        <PanelMuted>No managed skills configured.</PanelMuted>
      ) : (
        <ul className="divide-y divide-border" data-testid="eaos-agent-detail-skills-list">
          {entries.slice(0, 6).map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-3 py-2 text-xs">
              <span className="min-w-0 truncate text-foreground">{redactSecretLikeText(entry.runtimeName ?? entry.key)}</span>
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {humanizeToken(entry.state)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </OverviewPanel>
  );
}

function ChainPanel({ chain }: { chain: AgentDetail["chainOfCommand"] }) {
  return (
    <OverviewPanel title="Chain of command" icon={Network} testId="eaos-agent-detail-chain-panel">
      {chain.length === 0 ? (
        <PanelMuted>This agent is at the top of the company chain.</PanelMuted>
      ) : (
        <ol className="space-y-2">
          {chain.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 text-xs">
              <AgentAvatar
                size="sm"
                variant="initials"
                subject={{ kind: "agent", agentId: entry.id, name: entry.name, role: entry.role }}
                testId="eaos-agent-detail-chain-avatar"
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{redactSecretLikeText(entry.name)}</span>
              <span className="text-muted-foreground">{AGENT_ROLE_LABELS[entry.role] ?? humanizeToken(entry.role)}</span>
            </li>
          ))}
        </ol>
      )}
    </OverviewPanel>
  );
}

function SessionsPanel({ sessions, loading }: { sessions: readonly AgentTaskSession[]; loading: boolean }) {
  return (
    <OverviewPanel title="Task sessions" icon={KeyRound} testId="eaos-agent-detail-sessions-panel">
      {loading ? (
        <PanelMuted>Loading task sessions…</PanelMuted>
      ) : sessions.length === 0 ? (
        <PanelMuted>No task-specific sessions recorded.</PanelMuted>
      ) : (
        <ul className="divide-y divide-border">
          {sessions.slice(0, 6).map((session) => (
            <li key={session.id} className="py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-foreground">{safeDisplayText(session.taskKey, 160)}</span>
                <span className="shrink-0 text-muted-foreground">{humanizeAdapterType(session.adapterType)}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {session.sessionDisplayId ? redactSecretLikeText(session.sessionDisplayId) : "No session id"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </OverviewPanel>
  );
}

function OverviewPanel({
  title,
  icon: Icon,
  testId,
  children,
}: {
  title: string;
  icon: LucideIcon;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card" data-testid={testId}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3" data-testid={`eaos-agent-detail-metric-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-2 text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground" data-testid={`eaos-agent-detail-property-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ agent }: { agent: Agent }) {
  const tone =
    agent.status === "running"
      ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100"
      : agent.status === "active" || agent.status === "idle"
        ? "border-green-300 bg-green-50 text-green-800 dark:border-green-600 dark:bg-green-950 dark:text-green-100"
        : agent.status === "paused"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
          : agent.status === "error"
            ? "border-red-300 bg-red-50 text-red-800 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
            : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
      data-testid="eaos-agent-detail-status"
      title={humanizeAgentStatus(agent.status)}
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      {humanizeAgentStatus(agent.status)}
    </span>
  );
}

function BudgetBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} />
    </div>
  );
}

function PanelMuted({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

function AgentDetailLoading() {
  return (
    <section
      aria-labelledby="eaos-agent-detail-loading-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-agent-detail-loading"
    >
      <EaosPageHeader
        title="Agent"
        breadcrumb={<Link to="/eaos/agents" className="hover:text-foreground">Agents</Link>}
        testId="eaos-agent-detail-loading-header"
      />
      <div className="px-4 py-4 sm:px-6 lg:px-8">
        <h1 id="eaos-agent-detail-loading-title" className="sr-only">Agent detail</h1>
        <div role="status" aria-live="polite" className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          Loading agent detail…
        </div>
      </div>
    </section>
  );
}

function AgentDetailEmptyShell({
  testId,
  title,
  body,
  onRetry,
}: {
  testId: string;
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <section
      aria-labelledby={`${testId}-title`}
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid={testId}
    >
      <EaosPageHeader
        title="Agent"
        breadcrumb={<Link to="/eaos/agents" className="hover:text-foreground">Agents</Link>}
        testId={`${testId}-header`}
      />
      <div className="px-4 py-4 sm:px-6 lg:px-8">
        <div className="rounded-md border border-border bg-card p-4">
          <Link
            to="/eaos/agents"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            Back to agents
          </Link>
          <h1 id={`${testId}-title`} className="mt-3 text-base font-semibold text-foreground">
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={() => onRetry()}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function relativeOrNever(when: Date | null, now: Date): string {
  if (!when) return "Never";
  const deltaMs = now.getTime() - when.getTime();
  if (deltaMs < 0) return "Just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatUsdCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars >= 100) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US").format(value);
}

function humanizeToken(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}
