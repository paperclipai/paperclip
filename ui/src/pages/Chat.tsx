import { useCallback, useRef } from "react";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { IssueChatThread, type IssueChatComposerHandle } from "../components/IssueChatThread";
import { flattenIssueCommentPages, getNextIssueCommentPageParam } from "../lib/optimistic-issue-comments";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import type { IssueComment } from "@paperclipai/shared";
import type { InfiniteData } from "@tanstack/react-query";

const COMMENT_PAGE_SIZE = 50;

interface CeoChatPanelProps {
  issueId: string;
  companyId: string;
}

function CeoChatPanel({ issueId, companyId }: CeoChatPanelProps) {
  const queryClient = useQueryClient();
  const composerRef = useRef<IssueChatComposerHandle | null>(null);

  const {
    data: commentPages,
    refetch: refetchComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: ({ pageParam }) =>
      issuesApi.listComments(issueId, {
        order: "desc",
        limit: COMMENT_PAGE_SIZE,
        ...(pageParam ? { after: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      getNextIssueCommentPageParam(lastPage, COMMENT_PAGE_SIZE),
    placeholderData: (prev: InfiniteData<IssueComment[], string | null> | undefined) => prev,
  });

  const comments = flattenIssueCommentPages(commentPages?.pages);

  const addCommentMutation = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId, body, reopen),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
    },
  });

  const onAdd = useCallback(
    async (body: string, reopen?: boolean) => {
      await addCommentMutation.mutateAsync({ body, reopen });
    },
    [addCommentMutation],
  );

  const onRefreshLatestComments = useCallback(async () => {
    await refetchComments();
  }, [refetchComments]);

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <IssueChatThread
        composerRef={composerRef}
        comments={comments}
        companyId={companyId}
        issueStatus="in_progress"
        onAdd={onAdd}
        onRefreshLatestComments={onRefreshLatestComments}
        showJumpToLatest
      />
    </div>
  );
}

export function Chat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const navigate = useNavigate();

  const { data: ceoChatHandle, isLoading, error } = useQuery({
    queryKey: ["ceoChat", selectedCompanyId],
    queryFn: () => issuesApi.getCeoChat(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 3;
    },
  });

  const prefix = selectedCompany?.issuePrefix ?? "";

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  const is404 =
    error instanceof ApiError && error.status === 404;

  if (is404 || (error && !ceoChatHandle)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">
          No CEO agent is assigned yet. Hire your CEO to start chatting.
        </p>
        <Button onClick={() => navigate(`/${prefix}/agents/new`)}>
          Hire your CEO
        </Button>
      </div>
    );
  }

  if (!ceoChatHandle) {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      <CeoChatPanel
        issueId={ceoChatHandle.issueId}
        companyId={ceoChatHandle.companyId}
      />
    </div>
  );
}
