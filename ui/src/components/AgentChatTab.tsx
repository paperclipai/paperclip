import { memo, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi, type AgentThreadMessagesResponse } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatComment, IssueChatLinkedRun } from "../lib/issue-chat-messages";
import { queryKeys } from "../lib/queryKeys";

const EMPTY_TIMELINE_EVENTS: [] = [];
const ACTIVE_STATUSES = new Set(["queued", "running"]);

function createOptimisticMessageId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `optimistic-${randomUuid}`;
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface AgentChatTabProps {
  agentId: string;
  companyId: string;
  runs: HeartbeatRun[];
}

function runThreadId(run: HeartbeatRun) {
  const context = run.contextSnapshot as Record<string, unknown> | null | undefined;
  const value = context?.agentThreadId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const AgentChatTab = memo(function AgentChatTab({
  agentId,
  companyId,
  runs,
}: AgentChatTabProps) {
  const queryClient = useQueryClient();
  const [optimisticMessages, setOptimisticMessages] = useState<IssueChatComment[]>([]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const { data: threadResult } = useQuery({
    queryKey: queryKeys.agents.threadMessages(agentId, companyId),
    queryFn: () => agentsApi.threadMessages(agentId, companyId),
    enabled: Boolean(agentId) && Boolean(companyId),
    refetchInterval: 3000,
  });

  const threadId = threadResult?.thread?.id ?? null;

  const { data: companyLiveRuns } = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId, agentId), "live"] as const,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { agentId }),
    enabled: Boolean(companyId) && Boolean(agentId) && Boolean(threadId),
    refetchInterval: 3000,
  });

  const comments = useMemo<IssueChatComment[]>(() => {
    const serverMessages = (threadResult?.messages ?? []).map((message) => ({
      id: message.id,
      companyId: message.companyId,
      issueId: message.threadId,
      authorAgentId: message.authorAgentId,
      authorUserId: message.authorUserId,
      body: message.body,
      createdAt: new Date(message.createdAt),
      updatedAt: new Date(message.updatedAt),
      runId: message.producingHeartbeatRunId ?? null,
      runAgentId: message.authorAgentId ?? null,
    }));

    // Merge optimistic messages with server messages, avoiding duplicates
    const serverMessageIds = new Set(serverMessages.map((m) => m.id));
    const activeOptimistic = optimisticMessages.filter((m) => !serverMessageIds.has(m.id));

    return [...serverMessages, ...activeOptimistic].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [threadResult?.messages, optimisticMessages]);

  const threadRunIds = useMemo(
    () =>
      new Set(
        runs
          .filter((run) => threadId && runThreadId(run) === threadId)
          .map((run) => run.id),
      ),
    [runs, threadId],
  );

  const linkedRuns = useMemo<IssueChatLinkedRun[]>(
    () =>
      runs
        .filter((run) => threadId && runThreadId(run) === threadId)
        .filter((run) => !ACTIVE_STATUSES.has(run.status))
        .map((run) => ({
          runId: run.id,
          status: run.status,
          agentId: run.agentId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          hasStoredOutput: (run.logBytes ?? 0) > 0,
        })),
    [runs, threadId],
  );

  const liveRuns = useMemo<LiveRunForIssue[]>(
    () => (companyLiveRuns ?? []).filter((run) => threadRunIds.has(run.id)),
    [companyLiveRuns, threadRunIds],
  );

  const handleAdd = async (body: string) => {
    // Create optimistic message
    const optimisticId = createOptimisticMessageId();
    const now = new Date();
    const optimisticMessage: IssueChatComment = {
      id: optimisticId,
      clientId: optimisticId,
      clientStatus: "pending",
      companyId,
      issueId: threadId ?? "",
      authorAgentId: null,
      authorUserId: currentUserId,
      body,
      createdAt: now,
      updatedAt: now,
      runId: null,
      runAgentId: null,
    };

    // Add optimistic message immediately
    setOptimisticMessages((prev) => [...prev, optimisticMessage]);

    try {
      // Send to server
      const result = await agentsApi.postThreadMessage(agentId, body, companyId);

      // Remove optimistic message now that real one is coming
      setOptimisticMessages((prev) => prev.filter((m) => m.clientId !== optimisticId));

      // Invalidate queries to fetch the real message
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.thread(agentId, companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.threadMessages(agentId, companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, agentId) }),
      ]);

      // Mark as read (non-critical, don't fail the send if this errors)
      try {
        await agentsApi.markThreadRead(
          agentId,
          { lastReadMessageId: result.message.id },
          companyId,
        );
      } catch (readError) {
        console.error("Failed to mark thread as read:", readError);
        // Continue - message was sent successfully
      }
    } catch (error) {
      // On error, remove optimistic message
      setOptimisticMessages((prev) => prev.filter((m) => m.clientId !== optimisticId));
      // Re-throw to let IssueChatThread handle error (e.g., restore draft)
      throw error;
    }
  };

  return (
    <IssueChatThread
      comments={comments}
      linkedRuns={linkedRuns}
      timelineEvents={EMPTY_TIMELINE_EVENTS}
      liveRuns={liveRuns}
      companyId={companyId}
      currentUserId={currentUserId}
      onAdd={handleAdd}
      showComposer
      showJumpToLatest={false}
      variant="full"
      emptyMessage="Start direct conversation with this agent."
      enableLiveTranscriptPolling
      includeSucceededRunsWithoutOutput
    />
  );
});
