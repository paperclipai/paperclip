import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { reviewPipelineApi } from "../api/reviewPipeline";
import { ReviewRunCard } from "./ReviewRunCard";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { queryKeys } from "../lib/queryKeys";

export function IssueReviewSection({ companyId, issueId }: { companyId: string; issueId: string }) {
  const queryClient = useQueryClient();
  const [rejectRunId, setRejectRunId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.reviewPipeline.issueReviews(companyId, issueId),
    queryFn: () => reviewPipelineApi.getIssueReviews(companyId, issueId),
  });

  const approveMutation = useMutation({
    mutationFn: (runId: string) => reviewPipelineApi.approveRun(companyId, issueId, runId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.reviewPipeline.issueReviews(companyId, issueId),
      }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ runId, note }: { runId: string; note: string }) =>
      reviewPipelineApi.rejectRun(companyId, issueId, runId, note),
    onSuccess: () => {
      setRejectRunId(null);
      setRejectNote("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.reviewPipeline.issueReviews(companyId, issueId),
      });
    },
  });

  if (isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
      </div>
    );

  if (!runs || runs.length === 0)
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        리뷰가 없습니다. PR이 올라오면 자동으로 리뷰가 시작됩니다.
      </div>
    );

  const sortedRuns = [...runs].reverse();

  return (
    <div className="space-y-4">
      {sortedRuns.map((run) => (
        <ReviewRunCard
          key={run.id}
          run={run}
          onApprove={() => approveMutation.mutate(run.id)}
          onReject={() => setRejectRunId(run.id)}
          isApproving={approveMutation.isPending}
        />
      ))}
      <Dialog open={!!rejectRunId} onOpenChange={() => setRejectRunId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PR 반려</DialogTitle>
          </DialogHeader>
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            rows={4}
            placeholder="반려 사유를 입력하세요..."
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRejectRunId(null)}>
              취소
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectNote.trim() || rejectMutation.isPending}
              onClick={() =>
                rejectRunId &&
                rejectMutation.mutate({ runId: rejectRunId, note: rejectNote })
              }
            >
              반려
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
