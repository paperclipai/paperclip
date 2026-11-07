import { t, useTranslation, Trans } from "@/i18n";
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
  useTranslation("task-components");
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
  useTranslation("task-components");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const idleDays = attentionIdleDays(item, now);
  const keep = useMutation({
    mutationFn: () => decisionQueuesApi.setKeep(companyId, item.sourceKind, item.subject.id, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ presentation: { title: { key: "task-components:keptOnDesk_d5c41d42" } },  title: t("task-components:keptOnDesk_d5c41d42"), body: item.subject.title ?? undefined, tone: "success" });
    },
    onError: (error) =>
      pushToast({ presentation: { title: { key: "task-components:couldNotKeepThisDecision_f5156cd3" }, error: { cause: error } }, 
        title: t("task-components:couldNotKeepThisDecision_f5156cd3"),
        body: error instanceof Error ? error.message : t("final-components-a:pleaseTryAgain_eea4fb33"),
        tone: "error",
      }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-(length:--text-nano) text-muted-foreground"><Trans ns="final-components-a" i18nKey="numeric_ae5a0eb337d4" values={{ idleDays: idleDays }} components={{ part2: <>{idleDays === 1 ? t("task-components:day_944c27e5") : t("task-components:days_ab51004e")}</> }} /></span>
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
          {item.keep ? t("task-components:kept_c159e746") : t("task-components:keepOnDesk_00ede66c")}
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
