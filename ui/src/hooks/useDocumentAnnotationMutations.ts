import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DocumentAnnotationComment, DocumentAnnotationCommentReactionName, DocumentAnnotationCommentReactionSummary, DocumentAnnotationThreadStatus, DocumentAnnotationThreadWithComments } from "@paperclipai/shared";
import { DOCUMENT_ANNOTATION_COMMENT_REACTIONS } from "@paperclipai/shared";
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
  const queryKeyHash = useMemo(() => JSON.stringify(queryKey), [queryKey]);

  useEffect(() => {
    let reapplying = false;
    return queryClient.getQueryCache().subscribe((event) => {
      if (reapplying) return;
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
      const reactionState = peekTargetReactionState(queryClient, queryKeyHash);
      if (!reactionState || reactionState.pendingChoices.size === 0) return;
      if (JSON.stringify(event.query.queryKey) !== queryKeyHash) return;
      const current = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(queryKey);
      if (!current) return;
      const next = applyPendingReactionChoices(current, reactionState.pendingChoices.values());
      if (next === current) return;
      reapplying = true;
      try {
        queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, next);
      } finally {
        reapplying = false;
      }
    });
  }, [queryClient, queryKey, queryKeyHash]);

  const updateCommentReactions = useCallback((
    threadId: string,
    commentId: string,
    update: (reactions: DocumentAnnotationCommentReactionSummary[]) => DocumentAnnotationCommentReactionSummary[],
  ) => queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(queryKey, (current) => (current ?? []).map((thread) =>
    thread.id !== threadId ? thread : {
      ...thread,
      comments: thread.comments.map((comment) => comment.id === commentId
        ? { ...comment, reactions: update(comment.reactions ?? []) }
        : comment),
    })), [queryClient, queryKey]);
  const toggleReaction = useMutation({
    mutationFn: ({ threadId, commentId, reaction, present }: ReactionToggle) => {
      const reactionState = getTargetReactionState(queryClient, queryKeyHash);
      const key = reactionWriteKey(commentId, reaction);
      const previous = reactionState.writes.get(key);
      const write = (previous ? previous.catch(() => undefined) : Promise.resolve())
        .then(() => documentAnnotationsApi.setReactionForTarget(options.target, threadId, commentId, reaction, present));
      reactionState.writes.set(key, write);
      return write.finally(() => {
        if (reactionState.writes.get(key) === write) reactionState.writes.delete(key);
        cleanupTargetReactionState(queryClient, queryKeyHash, reactionState);
      });
    },
    onMutate: async ({ threadId, commentId, reaction, present }) => {
      const reactionState = getTargetReactionState(queryClient, queryKeyHash);
      const key = reactionWriteKey(commentId, reaction);
      reactionState.pendingCounts.set(key, (reactionState.pendingCounts.get(key) ?? 0) + 1);
      reactionState.pendingChoices.set(key, { threadId, commentId, reaction, present, userId: currentUser.id });
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey });
      let previous: DocumentAnnotationCommentReactionSummary | undefined;
      updateCommentReactions(threadId, commentId, (reactions) => {
        previous = reactions.find((entry) => entry.reaction === reaction);
        return applyOptimisticReaction(reactions, reaction, present, currentUser.id);
      });
      return { previous };
    },
    onError: (error, { threadId, commentId, reaction }, context) => {
      const reactionState = peekTargetReactionState(queryClient, queryKeyHash);
      const key = reactionWriteKey(commentId, reaction);
      if ((reactionState?.pendingCounts.get(key) ?? 0) <= 1 && context) {
        updateCommentReactions(threadId, commentId, (reactions) => replaceReaction(reactions, reaction, context.previous));
      }
      setMutationError(messageFor(error, "Failed to update reaction."));
    },
    onSuccess: (comment, { threadId, commentId, reaction }) => {
      setMutationError(null);
      const reactionState = peekTargetReactionState(queryClient, queryKeyHash);
      const key = reactionWriteKey(commentId, reaction);
      if ((reactionState?.pendingCounts.get(key) ?? 0) > 1) return;
      const otherPending = Array.from(reactionState?.pendingChoices.values() ?? []).filter(
        (choice) => choice.commentId === commentId && choice.reaction !== reaction,
      );
      updateCommentReactions(threadId, commentId, () => otherPending.reduce(
        (merged, choice) => applyOptimisticReaction(merged, choice.reaction, choice.present, choice.userId),
        comment.reactions ?? [],
      ));
    },
    onSettled: (_comment, _error, { commentId, reaction }) => {
      const reactionState = peekTargetReactionState(queryClient, queryKeyHash);
      if (!reactionState) return invalidateAll();
      const key = reactionWriteKey(commentId, reaction);
      const remaining = (reactionState.pendingCounts.get(key) ?? 1) - 1;
      if (remaining > 0) {
        reactionState.pendingCounts.set(key, remaining);
      } else {
        reactionState.pendingCounts.delete(key);
        reactionState.pendingChoices.delete(key);
      }
      const hasPending = reactionState.pendingCounts.size > 0;
      cleanupTargetReactionState(queryClient, queryKeyHash, reactionState);
      if (hasPending) return;
      return invalidateAll();
    },
  });
  return { createThread, addReply, updateStatus, toggleReaction, mutationError, currentUser };
}

interface TargetReactionState {
  writes: Map<string, Promise<DocumentAnnotationComment>>;
  pendingCounts: Map<string, number>;
  pendingChoices: Map<string, PendingReactionChoice>;
}

const reactionStateByClient = new WeakMap<QueryClient, Map<string, TargetReactionState>>();

function peekTargetReactionState(queryClient: QueryClient, queryKeyHash: string): TargetReactionState | undefined {
  return reactionStateByClient.get(queryClient)?.get(queryKeyHash);
}

function getTargetReactionState(queryClient: QueryClient, queryKeyHash: string): TargetReactionState {
  let byTarget = reactionStateByClient.get(queryClient);
  if (!byTarget) {
    byTarget = new Map();
    reactionStateByClient.set(queryClient, byTarget);
  }
  let state = byTarget.get(queryKeyHash);
  if (!state) {
    state = {
      writes: new Map(),
      pendingCounts: new Map(),
      pendingChoices: new Map(),
    };
    byTarget.set(queryKeyHash, state);
  }
  return state;
}

function cleanupTargetReactionState(queryClient: QueryClient, queryKeyHash: string, state: TargetReactionState) {
  if (state.writes.size > 0 || state.pendingCounts.size > 0 || state.pendingChoices.size > 0) return;
  const byTarget = reactionStateByClient.get(queryClient);
  if (byTarget?.get(queryKeyHash) === state) byTarget.delete(queryKeyHash);
}

interface PendingReactionChoice extends ReactionToggle {
  userId: string | null;
}

function applyPendingReactionChoices(
  threads: DocumentAnnotationThreadWithComments[],
  choices: Iterable<PendingReactionChoice>,
): DocumentAnnotationThreadWithComments[] {
  const byComment = new Map<string, PendingReactionChoice[]>();
  for (const choice of choices) {
    const list = byComment.get(choice.commentId) ?? [];
    list.push(choice);
    byComment.set(choice.commentId, list);
  }
  if (byComment.size === 0) return threads;
  let changed = false;
  const nextThreads = threads.map((thread) => {
    let threadChanged = false;
    const comments = thread.comments.map((comment) => {
      const pending = byComment.get(comment.id);
      if (!pending) return comment;
      const current = comment.reactions ?? [];
      const merged = pending.reduce(
        (acc, choice) => applyOptimisticReaction(acc, choice.reaction, choice.present, choice.userId),
        current,
      );
      if (merged === current) return comment;
      threadChanged = true;
      return { ...comment, reactions: merged };
    });
    if (!threadChanged) return thread;
    changed = true;
    return { ...thread, comments };
  });
  return changed ? nextThreads : threads;
}

function reactionWriteKey(commentId: string, reaction: DocumentAnnotationCommentReactionName) {
  return `${commentId}:${reaction}`;
}

export interface ReactionToggle {
  threadId: string;
  commentId: string;
  reaction: DocumentAnnotationCommentReactionName;
  present: boolean;
}

export function applyOptimisticReaction(
  reactions: DocumentAnnotationCommentReactionSummary[],
  reaction: DocumentAnnotationCommentReactionName,
  present: boolean,
  userId: string | null,
): DocumentAnnotationCommentReactionSummary[] {
  const existing = reactions.find((entry) => entry.reaction === reaction);
  if (Boolean(existing?.reactedByMe) === present) return reactions;
  const actors = (existing?.actors ?? []).filter((actor) => !(actor.actorType === "user" && actor.userId === userId));
  const next: DocumentAnnotationCommentReactionSummary = {
    reaction,
    count: Math.max(0, (existing?.count ?? 0) + (present ? 1 : -1)),
    reactedByMe: present,
    actors: present ? [...actors, { actorType: "user", agentId: null, userId }] : actors,
  };
  return replaceReaction(reactions, reaction, next.count > 0 ? next : undefined);
}

function replaceReaction(
  reactions: DocumentAnnotationCommentReactionSummary[],
  reaction: DocumentAnnotationCommentReactionName,
  entry: DocumentAnnotationCommentReactionSummary | undefined,
): DocumentAnnotationCommentReactionSummary[] {
  const merged = [...reactions.filter((existing) => existing.reaction !== reaction), ...(entry ? [entry] : [])];
  return DOCUMENT_ANNOTATION_COMMENT_REACTIONS.flatMap((name) => merged.filter((existing) => existing.reaction === name));
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
