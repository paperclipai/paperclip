import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentAnnotationComment, DocumentAnnotationThreadStatus, DocumentAnnotationThreadWithComments } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { queryKeys } from "@/lib/queryKeys";
import type { PendingAnchor } from "@/components/DocumentAnnotationLayer";

interface MutationOptions {
  target: DocumentAnnotationTarget;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  pendingAnchor: PendingAnchor | null;
  onFocusThread: (threadId: string | null) => void;
  onThreadCreated?: (thread: DocumentAnnotationThreadWithComments) => void;
  onReplyAdded?: (threadId: string) => void;
}

export function useDocumentAnnotationMutations(options: MutationOptions) {
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    staleTime: 5 * 60_000,
  });
  const currentUser = useMemo(() => ({
    id: session?.user?.id ?? null,
    name: session?.user?.name?.trim() || session?.user?.email?.trim() || "You",
    image: session?.user?.image ?? null,
  }), [session]);
  const queryKey = useMemo(() => options.target.kind === "routine"
    ? queryKeys.routines.documentAnnotations(options.target.routineId, options.target.documentKey, "all")
    : options.target.kind === "case"
      ? queryKeys.cases.documentAnnotations(options.target.caseId, options.target.documentKey, "all")
      : queryKeys.issues.documentAnnotations(options.target.issueId, options.target.documentKey, "all"), [options.target]);
  const invalidateAll = useCallback(() => queryClient.invalidateQueries({
    predicate: (query) => Array.isArray(query.queryKey)
      && query.queryKey[1] === "document-annotations"
      && query.queryKey[2] === (options.target.kind === "issue" ? options.target.issueId : options.target.kind === "case" ? options.target.caseId : options.target.routineId)
      && query.queryKey[3] === options.target.documentKey,
  }), [options.target, queryClient]);

  const createThread = useMutation({
    mutationFn: async (body: string) => {
      if (!options.pendingAnchor) throw new Error("No selection to anchor to.");
      if (!options.baseRevisionId) throw new Error("Document has no revision yet.");
      return documentAnnotationsApi.createForTarget(options.target, {
        baseRevisionId: options.baseRevisionId,
        baseRevisionNumber: options.baseRevisionNumber,
        selector: options.pendingAnchor.selector,
        body,
      });
    },
    onMutate: async (body) => {
      if (!options.pendingAnchor || !options.baseRevisionId) return undefined;
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(queryKey);
      const optimistic = buildOptimisticThread(body, options, currentUser);
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, (current) => [...(current ?? []), optimistic]);
      options.onFocusThread(optimistic.id);
      return { previous, optimisticId: optimistic.id };
    },
    onError: (error, _body, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setMutationError(messageFor(error, "Failed to create comment."));
    },
    onSuccess: (thread, _body, context) => {
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, (current) =>
        (current ?? []).map((entry) => entry.id === context?.optimisticId ? thread : entry));
      setMutationError(null);
      options.onFocusThread(thread.id);
      options.onThreadCreated?.(thread);
    },
    onSettled: invalidateAll,
  });

  const addReply = useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) => documentAnnotationsApi.addCommentForTarget(options.target, threadId, { body }),
    onMutate: async ({ threadId, body }) => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(queryKey);
      const optimistic = buildOptimisticComment(body, threadId, options.target, currentUser.id);
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, (current) => (current ?? []).map((thread) =>
        thread.id === threadId ? { ...thread, comments: [...thread.comments, optimistic], updatedAt: optimistic.createdAt } : thread));
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setMutationError(messageFor(error, "Failed to add reply."));
    },
    onSuccess: (_comment, variables) => {
      setMutationError(null);
      options.onReplyAdded?.(variables.threadId);
    },
    onSettled: invalidateAll,
  });

  const updateStatus = useMutation({
    mutationFn: ({ threadId, status }: { threadId: string; status: DocumentAnnotationThreadStatus }) => documentAnnotationsApi.updateStatusForTarget(options.target, threadId, status),
    onMutate: async ({ threadId, status }) => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(queryKey);
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, (current) => (current ?? []).map((thread) => thread.id === threadId ? { ...thread, status } : thread));
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setMutationError(messageFor(error, "Failed to update comment status."));
    },
    onSuccess: () => setMutationError(null),
    onSettled: invalidateAll,
  });
  return { createThread, addReply, updateStatus, mutationError, currentUser };
}

function messageFor(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback; }
function optimisticId(prefix: string) { return `${prefix}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`; }
function buildOptimisticComment(body: string, threadId: string, target: DocumentAnnotationTarget, userId: string | null): DocumentAnnotationComment {
  const now = new Date();
  return { id: optimisticId("optimistic-comment"), companyId: "", threadId, issueId: target.kind === "issue" ? target.issueId : null, routineId: target.kind === "routine" ? target.routineId : null, caseId: target.kind === "case" ? target.caseId : null, documentId: "", body, authorType: "user", authorAgentId: null, authorUserId: userId, createdByRunId: null, issueCommentId: null, createdAt: now, updatedAt: now };
}
function buildOptimisticThread(body: string, options: MutationOptions, user: { id: string | null }): DocumentAnnotationThreadWithComments {
  const id = optimisticId("optimistic-thread");
  const now = new Date();
  return { id, issueId: options.target.kind === "issue" ? options.target.issueId : null, routineId: options.target.kind === "routine" ? options.target.routineId : null, caseId: options.target.kind === "case" ? options.target.caseId : null, documentKey: options.target.documentKey, status: "open", anchorState: "active", selectedText: options.pendingAnchor!.selectedText, normalizedStart: options.pendingAnchor!.selector.position.normalizedStart, markdownStart: options.pendingAnchor!.selector.position.markdownStart, originalRevisionId: options.baseRevisionId!, originalRevisionNumber: options.baseRevisionNumber, currentRevisionId: options.baseRevisionId!, currentRevisionNumber: options.baseRevisionNumber, createdByUserId: user.id, createdAt: now, updatedAt: now, comments: [buildOptimisticComment(body, id, options.target, user.id)] } as unknown as DocumentAnnotationThreadWithComments;
}
