import { type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sun } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { decisionQueuesApi } from "../api/decisionQueues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { attentionIdleDays } from "../lib/attention";
import { AttentionQueueRow } from "./AttentionQueueRow";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { Button } from "./ui/button";

/**
 * A collapsible shelf header + body (snoozed / dismissed / aging / decided /
 * expired). Shared by the desk and the per-queue page so both collapse the same
 * way across both decision surfaces.
 */
export function Curtain({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number | string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <IssueGroupHeader
        label={count == null ? label : `${label} (${count})`}
        collapsible
        collapsed={!open}
        onToggle={onToggle}
        className="text-muted-foreground"
      />
      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}

/**
 * An aging-shelf row (§4.4): the standard card, prefaced by an idle-duration
 * label and a "Keep on desk" affordance that clears the shelf flag server-side
 * (P1 retention `keep`). Shared by the desk and the per-queue page.
 */
export function AgingItemRow({
  item,
  companyId,
  now,
  agentMap,
  agents,
  currentUserId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
}: {
  item: AttentionItem;
  companyId: string;
  now: number;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  expanded: boolean;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, snoozedUntil: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const idleDays = attentionIdleDays(item, now);
  const keep = useMutation({
    mutationFn: () => decisionQueuesApi.setKeep(companyId, item.sourceKind, item.subject.id, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ title: "Kept on desk", body: item.subject.title ?? undefined, tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Could not keep this decision",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-(length:--text-nano) text-muted-foreground">
          Idle {idleDays} {idleDays === 1 ? "day" : "days"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 gap-1"
          disabled={keep.isPending || item.keep}
          onClick={() => keep.mutate()}
        >
          {keep.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          <Sun className="h-3.5 w-3.5" />
          {item.keep ? "Kept" : "Keep on desk"}
        </Button>
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
