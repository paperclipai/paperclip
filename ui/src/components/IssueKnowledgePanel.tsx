import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { knowledgeApi } from "../api/knowledge";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { KnowledgeAttachDialog } from "./KnowledgeAttachDialog";
import { IssueKnowledgeCompactRow } from "./IssueKnowledgeCompactRow";

export function IssueKnowledgePanel({
  companyId,
  issueId,
}: {
  companyId: string;
  issueId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [attachOpen, setAttachOpen] = useState(false);

  const { data: companyKnowledge } = useQuery({
    queryKey: queryKeys.knowledge.list(companyId),
    queryFn: () => knowledgeApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: issueKnowledge, isLoading } = useQuery({
    queryKey: queryKeys.issues.knowledge(issueId),
    queryFn: () => knowledgeApi.listForIssue(issueId),
    enabled: !!issueId,
  });

  const attachedIds = useMemo(
    () => new Set((issueKnowledge ?? []).map((item) => item.knowledgeItemId)),
    [issueKnowledge]
  );
  const availableKnowledge = useMemo(
    () => (companyKnowledge ?? []).filter((item) => !attachedIds.has(item.id)),
    [attachedIds, companyKnowledge]
  );

  const invalidateKnowledge = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.knowledge(issueId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.list(companyId),
      }),
    ]);
  };

  const attachMutation = useMutation({
    mutationFn: async (knowledgeItemIds: string[]) => {
      const results = await Promise.allSettled(
        knowledgeItemIds.map((knowledgeItemId) =>
          knowledgeApi.attachToIssue(issueId, { knowledgeItemId })
        )
      );
      const attachedCount = results.filter(
        (result) => result.status === "fulfilled"
      ).length;
      const failedCount = results.length - attachedCount;
      if (attachedCount === 0) {
        const firstFailure = results.find(
          (result) => result.status === "rejected"
        );
        throw firstFailure?.status === "rejected"
          ? firstFailure.reason
          : new Error("Failed to attach knowledge");
      }
      return { attachedCount, failedCount };
    },
    onSuccess: async ({ attachedCount, failedCount }) => {
      setAttachOpen(false);
      await invalidateKnowledge();
      pushToast({
        title:
          failedCount > 0
            ? `${attachedCount} attached, ${failedCount} failed`
            : attachedCount === 1
            ? "Knowledge attached"
            : `${attachedCount} knowledge items attached`,
        tone: failedCount > 0 ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title:
          error instanceof Error ? error.message : "Failed to attach knowledge",
        tone: "error",
      });
    },
  });

  const detachMutation = useMutation({
    mutationFn: (knowledgeItemId: string) =>
      knowledgeApi.detachFromIssue(issueId, knowledgeItemId),
    onSuccess: async () => {
      await invalidateKnowledge();
      pushToast({ title: "Knowledge detached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title:
          error instanceof Error ? error.message : "Failed to detach knowledge",
        tone: "error",
      });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">
            Knowledge
          </h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {(issueKnowledge ?? []).length} attached
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttachOpen(true)}
            disabled={!companyKnowledge}
          >
            Attach note
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading knowledge…</p>
      ) : (issueKnowledge ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-5 text-sm text-muted-foreground">
          No shared knowledge attached to this issue yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card/50">
          {(issueKnowledge ?? []).map((attachment) => {
            const knowledgeItem = attachment.knowledgeItem;
            if (!knowledgeItem) return null;

            return (
              <div
                key={attachment.id}
                className="border-b border-border last:border-b-0"
              >
                <IssueKnowledgeCompactRow
                  knowledgeItem={knowledgeItem}
                  detaching={detachMutation.isPending}
                  onDetach={() =>
                    detachMutation.mutate(attachment.knowledgeItemId)
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      <KnowledgeAttachDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        items={companyKnowledge ?? []}
        excludedIds={attachedIds}
        title="Attach knowledge to issue"
        description="Search the company library and attach reusable context to this issue."
        confirmLabel="Attach selected"
        submitting={attachMutation.isPending}
        onConfirm={(knowledgeItemIds) =>
          attachMutation.mutate(knowledgeItemIds)
        }
      />
    </div>
  );
}
