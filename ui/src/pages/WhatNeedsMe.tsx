import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Inbox } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import { isInlineResolvable } from "../lib/attention";
import { PageSkeleton } from "../components/PageSkeleton";
import { AttentionQueueRow } from "../components/AttentionQueueRow";

export function WhatNeedsMe() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoExpandDone, setAutoExpandDone] = useState(false);
  const [clearedIds, setClearedIds] = useState<Set<string>>(() => new Set());

  const { dismiss, dismissedAtByKey } = useInboxDismissals(selectedCompanyId);

  useEffect(() => {
    setBreadcrumbs([{ label: "What needs me" }]);
  }, [setBreadcrumbs]);

  const { data: feed, isLoading, error } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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

  // Client-side guard: the server already filters dismissed rows, but this
  // keeps a just-dismissed row from flashing back before the refetch lands.
  const items = useMemo(() => {
    const list = feed?.items ?? [];
    return list.filter((item) => {
      if (clearedIds.has(item.id)) return false;
      const dismissedAt = dismissedAtByKey.get(item.dismissalKey);
      return !(dismissedAt != null && dismissedAt >= new Date(item.activityAt).getTime());
    });
  }, [feed, clearedIds, dismissedAtByKey]);

  // Auto-expand the topmost inline-capable decision, once, per converged UX.
  // Rank never reorders while interacting, so we only seed the default once.
  useEffect(() => {
    if (autoExpandDone || items.length === 0) return;
    const topInline = items.find((item) => isInlineResolvable(item));
    if (topInline) setExpandedId(topInline.id);
    setAutoExpandDone(true);
  }, [items, autoExpandDone]);

  const handleDismiss = (item: AttentionItem) => {
    dismiss(item.dismissalKey);
    setClearedIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    if (expandedId === item.id) setExpandedId(null);
  };

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">What needs me</h1>
        {items.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? "decision" : "decisions"}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {items.length === 0 ? (
        <ZeroState />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <AttentionQueueRow
              key={item.id}
              item={item}
              companyId={selectedCompanyId}
              expanded={expandedId === item.id}
              onToggleExpand={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
              onDismiss={handleDismiss}
              agentMap={agentMap}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ZeroState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <div className="mb-4 rounded-full bg-green-500/10 p-4">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
      </div>
      <p className="text-lg font-semibold text-foreground">You're all caught up</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Inbox className="h-4 w-4" />
        Nothing needs a decision from you right now.
      </p>
    </div>
  );
}
