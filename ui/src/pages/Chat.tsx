import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { api } from "../api/client";
import { chatApi, type ChatThread } from "../api/chat";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

const ANALYTICS_LEAD_AGENT_ID = "84eb8a83-6ede-4ec8-831e-6e5bddd1506b";

function threadTitle(thread: ChatThread) {
  return thread.title?.trim() || "Untitled thread";
}

function ThreadIdentity({ thread, agentMap }: { thread: ChatThread; agentMap: Map<string, Agent> }) {
  if (thread.createdByAgentId) {
    return (
      <Identity
        name={agentMap.get(thread.createdByAgentId)?.name ?? thread.createdByAgentId.slice(0, 8)}
        size="sm"
        className="text-muted-foreground"
      />
    );
  }

  if (thread.createdByUserId) {
    return <Identity name="Board" size="sm" className="text-muted-foreground" />;
  }

  return <Identity name="Unknown" size="sm" className="text-muted-foreground" />;
}

export function Chat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  const { data: threads, isLoading, error } = useQuery({
    queryKey: queryKeys.chat.threads(selectedCompanyId!),
    queryFn: () => chatApi.listThreads(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: analyticsIssue } = useQuery({
    queryKey: ["analytics-chat-issue", selectedCompanyId],
    queryFn: async () => {
      const issues = await api.get<{ id: string }[]>(
        `/companies/${selectedCompanyId}/issues?assigneeAgentId=${ANALYTICS_LEAD_AGENT_ID}&status=todo,in_progress&q=Analytics+Chat`,
      );
      return issues[0] ?? null;
    },
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  const sortedThreads = useMemo(
    () =>
      [...(threads ?? [])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [threads],
  );

  const createThread = useMutation({
    mutationFn: (nextTitle: string) =>
      chatApi.createThread(selectedCompanyId!, {
        title: nextTitle.trim() || null,
        issueId: analyticsIssue?.id ?? null,
      }),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(selectedCompanyId!) });
      setTitle("");
      setCreating(false);
      navigate(`/chat/${thread.id}`);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessageSquare} message="Select a company to view chat threads." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="text-lg font-semibold">Chat</h1>
        {creating ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              createThread.mutate(title);
            }}
          >
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Thread title (optional)"
              className="w-64"
            />
            <Button type="submit" size="sm" disabled={createThread.isPending}>
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setTitle("");
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New Thread
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="px-6 py-10 text-sm text-destructive">
            {(error as Error).message || "Failed to load chat threads."}
          </div>
        ) : null}

        {!error && !isLoading && sortedThreads.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            message="No chat threads yet. Start a conversation with your agents."
            action="New Thread"
            onAction={() => setCreating(true)}
          />
        ) : null}

        {!error && sortedThreads.length > 0 ? (
          <div>
            {sortedThreads.map((thread) => (
              <Link
                key={thread.id}
                to={`/chat/${thread.id}`}
                className="flex items-center gap-3 border-b border-border px-6 py-4 transition-colors hover:bg-accent/40"
              >
                <div className="rounded-md border border-border bg-muted/30 p-2 text-muted-foreground">
                  <MessageSquare className="h-4 w-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{threadTitle(thread)}</p>
                    <StatusBadge status={thread.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <ThreadIdentity thread={thread} agentMap={agentMap} />
                    <span className={cn(thread.issueId ? "" : "hidden")}>•</span>
                    {thread.issueId ? <span>Linked to issue</span> : null}
                  </div>
                </div>

                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeTime(thread.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
