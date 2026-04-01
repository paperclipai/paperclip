import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, ChatMessage, ChatMessageAttachment } from "@paperclipai/shared";
import { Send, Paperclip, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { AgentIcon } from "./AgentIconPicker";
import { MarkdownBody } from "./MarkdownBody";
import { chatApi } from "../api/chat";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { useChatTypingAgents } from "../hooks/useChatTypingAgents";

interface ChatRoomProps {
  roomId: string;
  /** For direct rooms, the agent on the other side. null for boardroom. */
  roomAgentId?: string | null;
  agentMap?: Map<string, Agent>;
}

type MessageWithAttachments = ChatMessage & {
  attachments?: (ChatMessageAttachment & { contentPath: string })[];
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatRoom({ roomId, roomAgentId, agentMap }: ChatRoomProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const typingAgentIds = useChatTypingAgents(selectedCompanyId ?? null, roomId, roomAgentId ?? null);

  const { data: messages = [], isLoading } = useQuery({
    queryKey: queryKeys.chat.messages(roomId),
    queryFn: () => chatApi.listMessages(selectedCompanyId!, roomId, { limit: 100 }),
    enabled: Boolean(selectedCompanyId && roomId),
    refetchInterval: 10_000,
  });

  // Messages come newest-first from API, reverse for display
  const sorted = [...(messages as MessageWithAttachments[])].reverse();

  const sendMessage = useMutation({
    mutationFn: async (body: string) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return chatApi.postMessage(selectedCompanyId, roomId, { body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(roomId) });
      setAutoScroll(true);
    },
  });

  const uploadMessage = useMutation({
    mutationFn: async ({ file, body }: { file: File; body?: string }) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return chatApi.postMessageWithAttachment(selectedCompanyId, roomId, file, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(roomId) });
      setAutoScroll(true);
    },
  });

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (pendingFile) {
      setPendingFile(null);
      setDraft("");
      uploadMessage.mutate({ file: pendingFile, body: body || undefined });
      return;
    }
    if (!body || sendMessage.isPending) return;
    setDraft("");
    sendMessage.mutate(body);
  }, [draft, sendMessage, pendingFile, uploadMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileSelect = useCallback((file: File) => {
    setPendingFile(file);
    inputRef.current?.focus();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
      // Reset so the same file can be selected again
      e.target.value = "";
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sorted.length, autoScroll]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, [roomId]);

  function renderAuthor(msg: ChatMessage) {
    if (msg.authorAgentId && agentMap) {
      const agent = agentMap.get(msg.authorAgentId);
      if (agent) {
        return (
          <span className="inline-flex items-center gap-1.5">
            <AgentIcon icon={(agent as any).iconName ?? "bot"} className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">{agent.name}</span>
          </span>
        );
      }
    }
    if (msg.authorUserId) {
      return <Identity name="You" size="xs" />;
    }
    return <span className="text-xs text-muted-foreground">Unknown</span>;
  }

  function renderAttachments(attachments?: (ChatMessageAttachment & { contentPath: string })[]) {
    if (!attachments || attachments.length === 0) return null;

    return (
      <div className="mt-2 space-y-2">
        {attachments.map((a) => {
          if (a.contentType.startsWith("image/")) {
            return (
              <div key={a.id} className="max-w-sm">
                <img
                  src={a.contentPath}
                  alt={a.originalFilename ?? "Attached image"}
                  className="rounded-md border border-border max-h-64 object-contain"
                />
                {a.originalFilename && (
                  <div className="text-xs text-muted-foreground mt-1">
                    {a.originalFilename} ({formatFileSize(a.byteSize)})
                  </div>
                )}
              </div>
            );
          }

          return (
            <a
              key={a.id}
              href={a.contentPath}
              download={a.originalFilename ?? undefined}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:bg-muted/50 transition-colors max-w-sm"
            >
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-sm truncate">
                  {a.originalFilename ?? "Attachment"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatFileSize(a.byteSize)} - {a.contentType}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col h-full", isDragOver && "ring-2 ring-primary ring-inset")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-4"
      >
        {isLoading && (
          <div className="text-center text-xs text-muted-foreground py-8">Loading messages...</div>
        )}
        {!isLoading && sorted.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-8">
            No messages yet. Start the conversation!
          </div>
        )}
        {sorted.map((msg) => (
          <div key={msg.id} className="group">
            <div className="flex items-baseline gap-2 mb-0.5">
              {renderAuthor(msg)}
              <span className="text-[10px] text-muted-foreground/60">
                {formatDateTime(msg.createdAt)}
              </span>
            </div>
            <div className="pl-0 prose prose-sm dark:prose-invert max-w-none">
              <MarkdownBody>{msg.body}</MarkdownBody>
            </div>
            {renderAttachments(msg.attachments)}
          </div>
        ))}
      </div>

      {/* Typing indicator */}
      {typingAgentIds.size > 0 && agentMap && (
        <TypingIndicator agentIds={typingAgentIds} agentMap={agentMap} />
      )}

      {/* Pending file indicator */}
      {pendingFile && (
        <div className="px-4 py-2 border-t border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm">
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{pendingFile.name}</span>
            <span className="text-xs text-muted-foreground">({formatFileSize(pendingFile.size)})</span>
            <button
              onClick={() => setPendingFile(null)}
              className="ml-auto p-0.5 rounded hover:bg-muted"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMessage.isPending}
            className="h-[38px] px-2"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={pendingFile ? "Add a message (optional), then press Enter to send" : "Type a message... (Enter to send, Shift+Enter for newline)"}
            rows={1}
            className={cn(
              "flex-1 resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm",
              "outline-none placeholder:text-muted-foreground/40",
              "min-h-[38px] max-h-[160px]",
            )}
            style={{ height: "auto" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
            }}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={(!draft.trim() && !pendingFile) || sendMessage.isPending || uploadMessage.isPending}
            className="h-[38px] px-3"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {(sendMessage.isError || uploadMessage.isError) && (
          <p className="text-xs text-destructive mt-1">
            Failed to send message. Try again.
          </p>
        )}
      </div>
    </div>
  );
}

function TypingIndicator({
  agentIds,
  agentMap,
}: {
  agentIds: Set<string>;
  agentMap: Map<string, Agent>;
}) {
  const agents = [...agentIds]
    .map((id) => agentMap.get(id))
    .filter((a): a is Agent => !!a);

  if (agents.length === 0) return null;

  const label =
    agents.length === 1
      ? `${agents[0].name} is typing`
      : agents.length === 2
        ? `${agents[0].name} and ${agents[1].name} are typing`
        : `${agents[0].name} and ${agents.length - 1} others are typing`;

  return (
    <div className="px-4 py-1.5 text-xs text-muted-foreground flex items-center gap-2">
      <span className="inline-flex items-center gap-1">
        <AgentIcon
          icon={(agents[0] as any).iconName ?? "bot"}
          className="h-3.5 w-3.5 text-muted-foreground"
        />
        <span>{label}</span>
      </span>
      <span className="inline-flex gap-0.5" aria-hidden>
        <span className="typing-dot h-1 w-1 rounded-full bg-muted-foreground/60 animate-[typing-pulse_1.4s_ease-in-out_infinite]" />
        <span className="typing-dot h-1 w-1 rounded-full bg-muted-foreground/60 animate-[typing-pulse_1.4s_ease-in-out_0.2s_infinite]" />
        <span className="typing-dot h-1 w-1 rounded-full bg-muted-foreground/60 animate-[typing-pulse_1.4s_ease-in-out_0.4s_infinite]" />
      </span>
    </div>
  );
}
