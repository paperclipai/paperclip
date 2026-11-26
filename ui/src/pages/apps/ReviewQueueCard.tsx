import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Loader2, MoreHorizontal, ShieldQuestion, X } from "lucide-react";
import type { Agent, ToolActionRequestListItem } from "@paperclipai/shared";
import { googleWorkspaceToolTitle, humanizeConnectionDisplayName } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { issuesApi } from "@/api/issues";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { describeError } from "@/api/errors";
import { agentsApi } from "@/api/agents";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DecisionCardFooter } from "@/components/DecisionCardFooter";
import { NeedsYouPanel, NeedsYouPanelNote, NeedsYouPanelRow } from "@/components/coordinator/NeedsYouCardKit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AppLogo } from "./AppLogo";

/**
 * "Ask first" review queue (M1b float / M9 card, PAP-10859).
 *
 * Renders pending `tool_action_requests` as prosumer cards with three choices:
 *   • Allow once   → approve this single request
 *   • Always allow → approve + create a trust rule (won't ask again)
 *   • Decline      → reject this request
 *
 * Pass `connectionId` to scope the queue to a single app (App detail); omit it
 * to show every pending request (Needs attention page).
 *
 * `layout="decisions"` draws each request as a decision card with no section
 * heading, for the Reviews page, which carries its own title and count.
 */
export function ReviewQueueCard({
  connectionId,
  emptyState = "hidden",
  heading = "Waiting for your OK",
  plain = false,
  layout = "queue",
}: {
  connectionId?: string;
  emptyState?: "hidden" | "reassure";
  heading?: string;
  plain?: boolean;
  layout?: "queue" | "decisions";
}) {
  const { selectedCompanyId } = useCompany();

  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests(selectedCompanyId ?? "__none__", "pending"),
    queryFn: () => toolsApi.listActionRequests(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });
  const view = useQueryView(query);

  const items = useMemo(() => {
    const all = query.data?.actionRequests ?? [];
    return connectionId ? all.filter((item) => item.connectionId === connectionId) : all;
  }, [query.data, connectionId]);

  const decisions = layout === "decisions";
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: decisions && !!selectedCompanyId && items.some((item) => item.requestedByAgentId),
  });
  const agents = useMemo(() => indexAgentsById(agentsQuery.data ?? []), [agentsQuery.data]);

  if (!selectedCompanyId) return null;
  if (query.isLoading || view.kind === "reconnecting") return null;
  if (view.kind === "error") return <QueryErrorState error={query.error} action="load connection reviews" onRetry={view.retry} retrying={view.isFetching} />;

  if (items.length === 0) {
    if (emptyState === "hidden") return null;
    return (
      <div className={plain ? "py-5 text-sm text-muted-foreground" : "rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground"}>
        Nothing is waiting for your OK right now.
      </div>
    );
  }

  if (decisions) {
    return (
      <ul aria-label="Requests to review" className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.request.id}>
            <ReviewRow companyId={selectedCompanyId} item={item} plain={false} decision agent={item.requestedByAgentId ? agents.get(item.requestedByAgentId) ?? null : null} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-bold text-foreground">{heading}</h2>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <ReviewRow key={item.request.id} companyId={selectedCompanyId} item={item} plain={plain} />
        ))}
      </div>
    </section>
  );
}

function ReviewRow({
  companyId,
  item,
  plain,
  decision = false,
  agent = null,
}: {
  companyId: string;
  item: ToolActionRequestListItem;
  plain: boolean;
  decision?: boolean;
  agent?: Agent | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [resolving, setResolving] = useState<null | "allow" | "always" | "decline">(null);

  const interactionQuery = useQuery({
    queryKey: queryKeys.issues.interactions(item.request.issueId ?? "__none__"),
    queryFn: () => issuesApi.listInteractions(item.request.issueId!),
    enabled: Boolean(item.request.issueId && item.request.interactionId),
  });
  const linkedInteraction = interactionQuery.data?.find(row => row.id === item.request.interactionId);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(companyId, "pending") });
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
    if (item.request.issueId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(item.request.issueId) });
  };

  const allowOnce = useMutation({
    mutationFn: () => toolsApi.approveActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("allow"),
    onSuccess: () => {
      pushToast({ title: "Allowed once", body: `${actionLabel(item)} can run this time.`, tone: "success" });
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error);
    },
    onSettled: () => setResolving(null),
  });

  const alwaysAllow = useMutation({
    mutationFn: async () => {
      return toolsApi.approveActionRequest(companyId, item.request.id, true);
    },
    onMutate: () => setResolving("always"),
    onSuccess: () => {
      pushToast({
        title: "Always allowed",
        body: `${actionLabel(item)} won’t ask again.`,
        tone: "success",
      });
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error);
    },
    onSettled: () => setResolving(null),
  });

  const decline = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("decline"),
    onSuccess: () => {
      pushToast({ title: "Declined", body: `${actionLabel(item)} won’t run.`, tone: "info" });
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error);
    },
    onSettled: () => setResolving(null),
  });

  if (decision && interactionQuery.isLoading) {
    return (
      <article className="coordinator-decision-card" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading request…</p>
      </article>
    );
  }

  if (linkedInteraction) {
    const card = <IssueThreadInteractionCard
    interaction={linkedInteraction}
    presentationVariant={decision ? "coordinator-decision" : "default"}
    primaryActionOnRight={decision}
    onAcceptInteraction={async (_interaction, _keys, _options, rememberAction) => {
      try { await toolsApi.approveActionRequest(companyId, item.request.id, rememberAction); }
      finally { invalidate(); }
    }}
    onRejectInteraction={async (_interaction, reason) => {
      try { await toolsApi.declineActionRequest(companyId, item.request.id, reason); }
      finally { invalidate(); }
    }}
  />;
    return decision ? <article className="coordinator-decision-card space-y-3">{card}</article> : card;
  }

  const busy = resolving !== null;
  const preview = item.request.previewMarkdown?.trim();
  const canAlwaysAllow = Boolean(item.requestedByAgentId && item.connectionId && !item.request.approvalId);

  if (decision) {
    const action = actionLabel(item);
    const app = item.applicationName ? humanizeConnectionDisplayName(item.applicationName) : null;
    const risk = item.riskLevel ? RISK_LABELS[item.riskLevel] : null;
    return (
      <article className={cn("coordinator-decision-card space-y-3", ANALYTICS_MASK_CLASS)} aria-label={app ? `${action} in ${app}` : action}>
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 truncate text-xs leading-4.5 text-muted-foreground">Approve tool access</span>
          <div className="flex shrink-0 items-center gap-3" data-attention-context>
            {agent ? (
              <span className="inline-flex min-w-0 items-center gap-2 text-xs leading-4.5 text-muted-foreground">
                <AgentAvatar agent={agent} size={20} />
                <span className="truncate">from {agent.name}</span>
              </span>
            ) : null}
            <time className="shrink-0 text-xs leading-4.5 text-muted-foreground" dateTime={new Date(item.request.createdAt).toISOString()}>
              {timeAgo(item.request.createdAt)}
            </time>
            {canAlwaysAllow ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="-mr-1.5 size-7 text-muted-foreground" aria-label={`More for ${action}`} disabled={busy}>
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={`w-72 ${ANALYTICS_MASK_CLASS}`}>
                  <DropdownMenuItem className="flex flex-col items-start gap-0.5 py-2" onSelect={() => alwaysAllow.mutate()}>
                    <span className="text-sm text-foreground">Always allow</span>
                    <span className="text-xs text-muted-foreground">This agent can run this action on this connection without asking again.</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        <div className="space-y-1.5">
          <h2>{app ? `${action} in ${app}` : action}</h2>
          <p className="text-sm text-muted-foreground">
            {app ? `${action} is set to Ask first in ${app}, so it waits for your OK.` : "This action is set to Ask first, so it waits for your OK."} Allow once runs it now.
          </p>
        </div>
        <NeedsYouPanel>
          {app ? (
            <NeedsYouPanelRow
              icon={<AppLogo name={app} size={20} compact className="bg-transparent" />}
              title={app}
              meta={<>{action}{risk ? <> · <span className={cn(risk.danger && "text-destructive")}>{risk.label}</span></> : null}</>}
            />
          ) : null}
          {preview ? <div className="text-sm"><MarkdownBody>{preview}</MarkdownBody></div> : null}
          {agent ? <NeedsYouPanelNote>Requested by {agent.name}.</NeedsYouPanelNote> : null}
        </NeedsYouPanel>
        <DecisionCardFooter
          leading={item.request.issueId ? (
            <Link to={`/issues/${item.request.issueId}`} className="flex max-w-full min-w-0 items-center gap-1.5 text-(length:--text-compact) leading-5 text-muted-foreground hover:text-foreground">
              <span className="min-w-0 truncate">{agent ? `Open task · Chat with ${agent.name}` : "Open task"}</span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden />
            </Link>
          ) : undefined}
        >
          <Button type="button" variant="ghost" onClick={() => decline.mutate()} disabled={busy}>
            {resolving === "decline" ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Decline
          </Button>
          <Button type="button" onClick={() => allowOnce.mutate()} disabled={busy}>
            {resolving === "allow" || resolving === "always" ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Allow once
          </Button>
        </DecisionCardFooter>
      </article>
    );
  }

  return (
    <div className={plain ? "py-3" : "rounded-xl border border-border bg-card p-4"}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-bold text-foreground">{actionLabel(item)}</span>
        {item.applicationName && (
          <span className="text-muted-foreground">
            in {humanizeConnectionDisplayName(item.applicationName)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">· asked {timeAgo(item.request.createdAt)}</span>
      </div>

      {preview ? (
        <div className="mt-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <MarkdownBody>{preview}</MarkdownBody>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          An agent wants to run this action. Your connection policy requires approval first.
        </p>
      )}

      {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <p className="mt-2 text-xs text-muted-foreground">Always allow lets this agent use this action with different arguments on this connection, within the current project when present.</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => allowOnce.mutate()} disabled={busy}>
          {resolving === "allow" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          Allow once
        </Button>
        {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <Button size="sm" variant="outline" onClick={() => alwaysAllow.mutate()} disabled={busy}>
          {resolving === "always" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Always allow
        </Button> : null}
        <Button size="sm" variant="ghost" onClick={() => decline.mutate()} disabled={busy}>
          {resolving === "decline" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
          Decline
        </Button>
      </div>
    </div>
  );
}

const RISK_LABELS: Record<NonNullable<ToolActionRequestListItem["riskLevel"]>, { label: string; danger: boolean }> = {
  low: { label: "Low risk", danger: false },
  medium: { label: "Medium risk", danger: false },
  high: { label: "High risk", danger: true },
  critical: { label: "Critical risk", danger: true },
  read: { label: "Reads data", danger: false },
  write: { label: "Changes data", danger: false },
  destructive: { label: "Destructive", danger: true },
};

export function indexAgentsById<T extends { id: string }>(agents: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const agent of agents) byId.set(agent.id, agent);
  return byId;
}

function actionLabel(item: ToolActionRequestListItem): string {
  if (!item.toolTitle && !item.toolName) return "This action";
  return humanizeConnectionDisplayName(item.toolName ?? "", { title: googleWorkspaceToolTitle(item.toolName ?? "", item.toolTitle) });
}

function failToast(
  pushToast: ReturnType<typeof useToast>["pushToast"],
  error: unknown,
) {
  pushToast({
    title: "Couldn’t save that",
    body: describeError(error).body,
    tone: "error",
  });
}
