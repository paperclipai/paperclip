import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MessageSquare, SendHorizontal } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { chatApi, type ChatMessage } from "../api/chat";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { InlineEditor } from "../components/InlineEditor";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";

function resolveMessageIdentity(message: ChatMessage, agentMap: Map<string, Agent>) {
  if (message.authorAgentId) {
    return {
      name: agentMap.get(message.authorAgentId)?.name ?? message.authorAgentId.slice(0, 8),
    };
  }
  if (message.authorUserId || message.role === "user") {
    return { name: "Board" };
  }
  if (message.role === "system") {
    return { name: "System" };
  }
  return { name: "Agent" };
}

function ChatBubble({ message, agentMap }: { message: ChatMessage; agentMap: Map<string, Agent> }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-2xl rounded-full border border-dashed border-border px-4 py-2 text-xs italic text-muted-foreground">
          {message.body}
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  const identity = resolveMessageIdentity(message, agentMap);

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className="max-w-3xl space-y-2">
        <div
          className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground",
            isUser ? "justify-end" : "justify-start",
          )}
        >
          {!isUser ? <Identity name={identity.name} size="sm" /> : null}
          <span title={formatDateTime(message.createdAt)}>{formatDateTime(message.createdAt)}</span>
          {isUser ? <Identity name={identity.name} size="sm" /> : null}
        </div>
        <div
          className={cn(
            "rounded-2xl border px-4 py-3 shadow-xs",
            isUser ? "border-primary/20 bg-primary/10" : "border-border bg-muted/50",
          )}
        >
          <MarkdownBody className="text-sm">{message.body}</MarkdownBody>
        </div>
      </div>
    </div>
  );
}

export function ChatThread() {
  const { threadId } = useParams<{ threadId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { data: thread, isLoading: threadLoading, error: threadError } = useQuery({
    queryKey: queryKeys.chat.threadDetail(threadId!),
    queryFn: () => chatApi.getThread(threadId!),
    enabled: !!threadId,
  });

  const { data: messages, isLoading: messagesLoading, error: messagesError } = useQuery({
    queryKey: queryKeys.chat.messages(threadId!),
    queryFn: () => chatApi.listMessages(threadId!),
    enabled: !!threadId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  const orderedMessages = useMemo(
    () =>
      [...(messages ?? [])].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [messages],
  );

  useEffect(() => {
    setBreadcrumbs([
      { label: "Chat", href: "/chat" },
      { label: thread?.title?.trim() || "Thread" },
    ]);
  }, [setBreadcrumbs, thread?.title]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [orderedMessages.length]);

  const invalidateThread = () => {
    if (!threadId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threadDetail(threadId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(threadId) });
    if (selectedCompanyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(selectedCompanyId) });
    }
  };

  const updateThread = useMutation({
    mutationFn: (data: { title?: string | null; status?: string }) =>
      chatApi.updateThread(threadId!, data),
    onSuccess: invalidateThread,
  });

  const sendMessage = useMutation({
    mutationFn: (body: string) =>
      chatApi.sendMessage(threadId!, { role: "user", body }),
    onSuccess: () => {
      setDraft("");
      invalidateThread();
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessageSquare} message="Select a company to view chat threads." />;
  }

  if (threadError) {
    return (
      <div className="px-6 py-10 text-sm text-destructive">
        {(threadError as Error).message || "Failed to load chat thread."}
      </div>
    );
  }

  if (!threadId || (!thread && threadLoading)) {
    return <div className="px-6 py-10 text-sm text-muted-foreground">Loading thread...</div>;
  }

  if (!thread) {
    return <EmptyState icon={MessageSquare} message="Thread not found." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
        <Link to="/chat" className="text-muted-foreground transition-colors hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <InlineEditor
          value={thread.title ?? ""}
          onSave={(value) => updateThread.mutateAsync({ title: value })}
          placeholder="Untitled thread"
          as="h1"
          className="flex-1 text-lg font-semibold"
        />
        <StatusBadge status={thread.status} />
        <Button
          size="sm"
          variant="outline"
          disabled={updateThread.isPending}
          onClick={() =>
            updateThread.mutate({
              status: thread.status === "open" ? "closed" : "open",
            })
          }
        >
          {thread.status === "open" ? "Close" : "Reopen"}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messagesError ? (
          <div className="py-10 text-sm text-destructive">
            {(messagesError as Error).message || "Failed to load messages."}
          </div>
        ) : null}

        {!messagesError && orderedMessages.length === 0 && !messagesLoading ? (
          <EmptyState icon={MessageSquare} message="No messages yet. Start the conversation below." />
        ) : null}

        {!messagesError && orderedMessages.length > 0 ? (
          <div className="space-y-4">
            {orderedMessages.map((message) => (
              <ChatBubble key={message.id} message={message} agentMap={agentMap} />
            ))}
            <div ref={bottomRef} />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border px-6 py-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Message</span>
          <span>Cmd/Ctrl+Enter to send</span>
        </div>
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          placeholder="Ask an agent for analysis, implementation, or next steps..."
          onSubmit={() => {
            const body = draft.trim();
            if (!body || sendMessage.isPending) return;
            sendMessage.mutate(body);
          }}
        />
        <div className="mt-3 flex justify-end">
          <Button
            disabled={!draft.trim() || sendMessage.isPending}
            onClick={() => sendMessage.mutate(draft.trim())}
          >
            <SendHorizontal className="h-4 w-4" />
            Send
          </Button>
        </div>
      </div>

      <ScrollToBottom />
    </div>
  );
}
