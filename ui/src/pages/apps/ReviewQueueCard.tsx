import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import type { ToolActionRequestListItem } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";

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
 */
export function ReviewQueueCard({
  connectionId,
  emptyState = "hidden",
  heading = "Waiting for your OK",
}: {
  connectionId?: string;
  emptyState?: "hidden" | "reassure";
  heading?: string;
}) {
  const { selectedCompanyId } = useCompany();

  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests(selectedCompanyId ?? "__none__", "pending"),
    queryFn: () => toolsApi.listActionRequests(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const items = useMemo(() => {
    const all = query.data?.actionRequests ?? [];
    return connectionId ? all.filter((item) => item.connectionId === connectionId) : all;
  }, [query.data, connectionId]);

  if (!selectedCompanyId) return null;
  if (query.isLoading) return null;

  if (items.length === 0) {
    if (emptyState === "hidden") return null;
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Nothing is waiting for your OK right now.
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <h2 className="text-sm font-bold text-foreground">{heading}</h2>
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          {items.length}
        </span>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <ReviewRow key={item.request.id} companyId={selectedCompanyId} item={item} />
        ))}
      </div>
    </section>
  );
}

function ReviewRow({ companyId, item }: { companyId: string; item: ToolActionRequestListItem }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [resolving, setResolving] = useState<null | "allow" | "always" | "decline">(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(companyId, "pending") });
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(companyId) });
  };

  const allowOnce = useMutation({
    mutationFn: () => toolsApi.approveActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("allow"),
    onSuccess: () => {
      pushToast({ title: "Allowed once", body: `${actionLabel(item)} can run this time.`, tone: "success" });
      invalidate();
    },
    onError: (error) => failToast(pushToast, error),
    onSettled: () => setResolving(null),
  });

  const alwaysAllow = useMutation({
    mutationFn: async () => {
      const approved = await toolsApi.approveActionRequest(companyId, item.request.id);
      await toolsApi.createTrustRuleFromActionRequest(companyId, item.request.id, { approvalThreshold: 1 });
      return approved;
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
    onError: (error) => failToast(pushToast, error),
    onSettled: () => setResolving(null),
  });

  const decline = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("decline"),
    onSuccess: () => {
      pushToast({ title: "Declined", body: `${actionLabel(item)} won’t run.`, tone: "info" });
      invalidate();
    },
    onError: (error) => failToast(pushToast, error),
    onSettled: () => setResolving(null),
  });

  const busy = resolving !== null;
  const preview = item.request.previewMarkdown?.trim();

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-4">
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
          An agent wants to run this action. It can change something, so we’re checking with you first.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => allowOnce.mutate()} disabled={busy}>
          {resolving === "allow" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          Allow once
        </Button>
        <Button size="sm" variant="outline" onClick={() => alwaysAllow.mutate()} disabled={busy}>
          {resolving === "always" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Always allow
        </Button>
        <Button size="sm" variant="ghost" onClick={() => decline.mutate()} disabled={busy}>
          {resolving === "decline" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
          Decline
        </Button>
      </div>
    </div>
  );
}

function actionLabel(item: ToolActionRequestListItem): string {
  if (!item.toolTitle && !item.toolName) return "This action";
  return humanizeConnectionDisplayName(item.toolName ?? "", { title: item.toolTitle });
}

function failToast(
  pushToast: ReturnType<typeof useToast>["pushToast"],
  error: unknown,
) {
  pushToast({
    title: "Couldn’t save that",
    body: error instanceof Error ? error.message : "Please try again.",
    tone: "error",
  });
}
