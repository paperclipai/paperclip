import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Settings2, X } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { useParams } from "@/lib/router";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { decisionQueuesApi } from "../api/decisionQueues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { AttentionQueueRow } from "../components/AttentionQueueRow";
import { DecisionQueueRail } from "../components/DecisionQueueRail";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
/**
 * Queue page (PAP-16032 §4.1 / wireframe screen 2). A homogeneous list of one
 * queue's pending decisions with per-item resolution, exclusion (with an
 * optional reason), and the queue's seed-rules card with an enable/disable
 * toggle. The list reuses the desk's card so a decision looks and resolves the
 * same wherever it is surfaced.
 */
export function DecisionQueuePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const params = useParams<{ key: string }>();
  const queueKey = params.key ?? "";
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { dismiss, snooze } = useInboxDismissals(selectedCompanyId);

  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(selectedCompanyId!),
    queryFn: () => decisionQueuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const queue = useMemo(() => queues?.find((q) => q.key === queueKey) ?? null, [queues, queueKey]);

  const {
    data: feed,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.attention(selectedCompanyId!), "queue", queueKey],
    queryFn: () => attentionApi.list(selectedCompanyId!, { queue: queueKey, all: true }),
    enabled: !!selectedCompanyId && !!queueKey,
    refetchOnWindowFocus: true,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions", href: "/decisions" }, { label: queue?.title ?? queueKey }]);
  }, [setBreadcrumbs, queue?.title, queueKey]);

  const items = useMemo(
    () => (feed?.items ?? []).filter((item) => !(item.dismissal?.isActive ?? false)),
    [feed],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId!) });
  };

  const toggleSeedRules = useMutation({
    mutationFn: (enabled: boolean) =>
      decisionQueuesApi.update(selectedCompanyId!, queueKey, { seedRulesEnabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId!) }),
    onError: (err) =>
      pushToast({
        title: "Could not update seeding",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }
  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{queue?.title ?? queueKey}</h1>
          {queue?.description && <p className="mt-0.5 text-sm text-muted-foreground">{queue.description}</p>}
        </div>
      </div>

      <DecisionQueueRail companyId={selectedCompanyId} activeQueueKey={queueKey} />

      {queue && queue.seedRules.length > 0 && (
        <SeedRulesCard
          enabled={queue.seedRulesEnabled}
          rules={queue.seedRules.map((rule) => rule.description)}
          pending={toggleSeedRules.isPending}
          onToggle={() => toggleSeedRules.mutate(!queue.seedRulesEnabled)}
        />
      )}

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-14 text-center">
          <p className="text-sm font-medium text-foreground">This queue is empty.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Decisions land here when they match the queue's rules or an agent adds them.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <QueueItemRow
              key={item.id}
              item={item}
              companyId={selectedCompanyId}
              queueKey={queueKey}
              agentMap={agentMap}
              agents={agents}
              currentUserId={currentUserId}
              expanded={expandedId === item.id}
              onToggleExpand={(next) => setExpandedId((prev) => (prev === next.id ? null : next.id))}
              onDismiss={(next) => dismiss(next.dismissalKey)}
              onSnooze={(next, until) => snooze(next.dismissalKey, until)}
              onExcluded={invalidate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SeedRulesCard({
  enabled,
  rules,
  pending,
  onToggle,
}: {
  enabled: boolean;
  rules: string[];
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Auto-seeding {enabled ? "on" : "off"}</p>
            <ul className="mt-1 space-y-0.5">
              {rules.map((rule) => (
                <li key={rule} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Button type="button" variant="outline" size="xs" className="h-7 shrink-0" disabled={pending} onClick={onToggle}>
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>
    </div>
  );
}

function QueueItemRow({
  item,
  companyId,
  queueKey,
  agentMap,
  agents,
  currentUserId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onExcluded,
}: {
  item: AttentionItem;
  companyId: string;
  queueKey: string;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  expanded: boolean;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, snoozedUntil: string) => void;
  onExcluded: () => void;
}) {
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const exclude = useMutation({
    mutationFn: async () => {
      await decisionQueuesApi.removeItem(
        companyId,
        queueKey,
        item.sourceKind,
        item.subject.id,
        reason.trim() || undefined,
      );
    },
    onSuccess: () => {
      setOpen(false);
      setReason("");
      pushToast({ title: "Removed from queue", body: item.subject.title ?? undefined, tone: "info" });
      onExcluded();
    },
    onError: (err) =>
      pushToast({
        title: "Could not exclude",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end px-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="h-7 gap-1 text-muted-foreground">
              <X className="h-3.5 w-3.5" />
              Exclude
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-2 p-3">
            <p className="text-xs font-medium text-foreground">Remove from this queue</p>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (optional)…"
              className="min-h-16 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
            />
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                className={cn(exclude.isPending && "opacity-80")}
                disabled={exclude.isPending}
                onClick={() => exclude.mutate()}
              >
                {exclude.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Exclude
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <AttentionQueueRow
        item={item}
        companyId={companyId}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onDismiss={onDismiss}
        onSnooze={onSnooze}
        agentMap={agentMap}
        agents={agents}
        showTriage
        currentUserId={currentUserId}
      />
    </div>
  );
}
