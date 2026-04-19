/**
 * AgentChatTab — Interactive chat UI for direct agent conversations
 * with a history sidebar for browsing past sessions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "../lib/utils";
import {
  Send,
  X,
  Loader2,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Paperclip,
  FileText,
  Download,
  History,
  ArrowLeft,
  CheckCheck,
} from "lucide-react";
import type { Agent, AssetImage } from "@paperclipai/shared";
import { agentsApi, type ChatHistorySession, type ChatHistoryMessage } from "../api/agents";
import { assetsApi } from "../api/assets";
import { type LiveRunForIssue } from "../api/heartbeats";
import { MarkdownBody } from "./MarkdownBody";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

// ── Types ──────────────────────────────────────────────────────────

interface ChatAttachment {
  assetId: string;
  contentPath: string;
  contentType: string;
  originalFilename: string | null;
}

interface ChatMessage {
  id: string;
  sessionId: string;
  agentId: string;
  sender: "user" | "agent";
  content: string;
  attachments?: ChatAttachment[];
  readAt?: string | null;
  createdAt: string;
}

interface ChatSession {
  id: string;
  agentId: string;
  companyId: string;
  startedByUserId: string;
  startedAt: string;
  lastActivityAt: string;
  messages: ChatMessage[];
}

/** Pending attachment (uploaded but not yet sent with a message) */
interface PendingAttachment {
  assetId: string;
  contentPath: string;
  contentType: string;
  originalFilename: string | null;
  previewUrl?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

function formatSessionDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Attachment chips (preview before sending) ─────────────────────

function PendingAttachmentChip({ att, onRemove }: { att: PendingAttachment; onRemove: () => void }) {
  return (
    <div className="relative group inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs">
      {isImageType(att.contentType) && att.previewUrl ? (
        <img src={att.previewUrl} alt={att.originalFilename ?? "attachment"} className="h-8 w-8 rounded object-cover" />
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground" />
      )}
      <span className="max-w-[120px] truncate text-muted-foreground">{att.originalFilename ?? "file"}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Inline attachment rendering (in message bubbles) ──────────────

function MessageAttachments({ attachments, isUser }: { attachments: ChatAttachment[]; isUser: boolean }) {
  if (!attachments.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {attachments.map((att) =>
        isImageType(att.contentType) ? (
          <a key={att.assetId} href={att.contentPath} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={att.contentPath}
              alt={att.originalFilename ?? "image"}
              className="max-h-48 max-w-full rounded border border-border/50 object-contain"
            />
          </a>
        ) : (
          <a
            key={att.assetId}
            href={att.contentPath}
            download={att.originalFilename ?? undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              isUser
                ? "border-primary-foreground/30 text-primary-foreground/80 hover:bg-primary-foreground/10"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            <Download className="h-3 w-3" />
            <span className="max-w-[140px] truncate">{att.originalFilename ?? "file"}</span>
          </a>
        ),
      )}
    </div>
  );
}

// ── History Sidebar ───────────────────────────────────────────────

function ChatHistorySidebar({
  agent,
  companyId,
  activeSessionId,
  onSelectSession,
  viewingHistoryId,
}: {
  agent: Agent;
  companyId: string;
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  viewingHistoryId: string | null;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["chat-history", agent.id, companyId],
    queryFn: () => agentsApi.chatHistory(agent.id, companyId, { limit: 30 }),
    refetchInterval: 30000,
  });

  const sessions = data?.sessions ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        <span>Chat History</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div className="px-3 py-6 text-xs text-muted-foreground text-center">No past sessions</div>
        )}

        {/* Active session indicator */}
        {activeSessionId && (
          <button
            type="button"
            className={cn(
              "w-full text-left px-3 py-2 border-b border-border hover:bg-muted/50 transition-colors",
              !viewingHistoryId && "bg-muted/70",
            )}
            onClick={() => onSelectSession("")}
          >
            <div className="flex items-center gap-1.5 text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 flex-shrink-0" />
              <span className="font-medium text-foreground truncate">Active session</span>
            </div>
          </button>
        )}

        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={cn(
              "w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 transition-colors",
              viewingHistoryId === session.id && "bg-muted/70",
            )}
            onClick={() => onSelectSession(session.id)}
          >
            <div className="text-[11px] text-muted-foreground mb-0.5">
              {formatSessionDate(session.startedAt)}
              <span className="mx-1">&middot;</span>
              {session.messageCount} msg{session.messageCount !== 1 ? "s" : ""}
            </div>
            {session.firstMessagePreview && (
              <p className="text-xs text-foreground/80 truncate">{session.firstMessagePreview}</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── History Viewer (read-only past session) ───────────────────────

function ChatHistoryViewer({
  agent,
  companyId,
  sessionId,
  onBack,
}: {
  agent: Agent;
  companyId: string;
  sessionId: string;
  onBack: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["chat-history-messages", agent.id, sessionId],
    queryFn: () => agentsApi.chatHistoryMessages(agent.id, sessionId, companyId),
  });

  const messages = data?.messages ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 pb-3 border-b border-border">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-7 px-2">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-sm text-muted-foreground">
          Past session &middot; {messages.length} message{messages.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-3">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn("flex", msg.sender === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                msg.sender === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
              )}
            >
              {msg.sender === "agent" ? (
                <MarkdownBody className="text-sm">{msg.content}</MarkdownBody>
              ) : (
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              )}
              {msg.attachments && msg.attachments.length > 0 && (
                <MessageAttachments attachments={msg.attachments} isUser={msg.sender === "user"} />
              )}
              <span className="block text-[10px] opacity-50 mt-1">{new Date(msg.createdAt).toLocaleTimeString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────

export function AgentChatTab({ agent, companyId }: { agent: Agent; companyId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [activeRun, setActiveRun] = useState<LiveRunForIssue | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingSignaledRef = useRef(false);

  // Track the agent's active chat process while typing
  useEffect(() => {
    if (!isTyping) {
      setActiveRun(null);
      return;
    }

    let cancelled = false;

    const pollChatProcess = async () => {
      try {
        const proc = await agentsApi.chatProcess(agent.id, companyId);
        if (cancelled) return;
        if (proc && proc.status === "running") {
          setActiveRun({
            id: proc.id,
            status: "running",
            invocationSource: "on_demand",
            triggerDetail: null,
            startedAt: proc.startedAt,
            finishedAt: null,
            createdAt: proc.startedAt,
            agentId: agent.id,
            agentName: agent.name,
            adapterType: agent.adapterType,
          });
        }
      } catch {
        // Ignore errors
      }
    };

    void pollChatProcess();
    const interval = setInterval(pollChatProcess, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isTyping, companyId, agent.id, agent.name]);

  // Reset thinking accordion to open when a new typing session starts
  useEffect(() => {
    if (isTyping) setThinkingOpen(true);
  }, [isTyping]);

  const runs = useMemo(() => (activeRun ? [activeRun] : []), [activeRun]);
  const { transcriptByRun } = useLiveRunTranscripts({ runs, companyId, maxChunksPerRun: 120 });
  const transcript = activeRun ? (transcriptByRun.get(activeRun.id) ?? []) : [];

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Helper: add a message if not already present
  const addMessageIfNew = useCallback(
    (msg: ChatMessage) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      lastMessageIdRef.current = msg.id;
      if (msg.sender === "agent") {
        setIsTyping(false);
        setRemoteTyping(false);
        // Auto-mark agent messages as read (user is viewing the chat)
        agentsApi.chatMarkRead(agent.id, [msg.id], companyId).catch(() => {});
      }
    },
    [agent.id, companyId],
  );

  // Signal typing state to the server with debounce
  const signalTyping = useCallback(
    (typing: boolean) => {
      if (!sessionId) return;
      if (typing === isTypingSignaledRef.current) return;
      isTypingSignaledRef.current = typing;
      agentsApi.chatTyping(agent.id, typing, companyId).catch(() => {});
    },
    [sessionId, agent.id, companyId],
  );

  const handleTypingInput = useCallback(() => {
    signalTyping(true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => signalTyping(false), 3000);
  }, [signalTyping]);

  // Primary: WebSocket for real-time chat messages
  useEffect(() => {
    if (!sessionId || !companyId) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { type: string; companyId: string; payload?: Record<string, unknown> };
          if (parsed.companyId !== companyId) return;

          const payload = parsed.payload ?? {};
          const eventAgentId = payload.agentId as string | undefined;
          if (eventAgentId !== agent.id) return;

          if (parsed.type === "chat.message.sent" || parsed.type === "chat.message.received") {
            const msgId = payload.messageId as string;
            const sender = payload.sender as "user" | "agent";
            const content = payload.content as string | undefined;

            // For received messages (agent responses), content is in the payload
            // For sent messages (user), we already have it locally
            if (msgId && sender === "agent" && content) {
              addMessageIfNew({
                id: msgId,
                sessionId: (payload.sessionId as string) ?? sessionId,
                agentId: agent.id,
                sender,
                content,
                createdAt: new Date().toISOString(),
              });
            }
          }

          if (parsed.type === "chat.typing") {
            const who = payload.who as string;
            const typing = payload.isTyping as boolean;
            // Show typing indicator when the agent is typing (not user's own typing)
            if (who === "agent") {
              setRemoteTyping(typing);
            }
          }

          if (parsed.type === "chat.messages.read") {
            const readMsgIds = payload.messageIds as string[];
            const readAt = payload.readAt as string;
            if (readMsgIds && readAt) {
              setMessages((prev) => prev.map((m) => (readMsgIds.includes(m.id) ? { ...m, readAt } : m)));
            }
          }

          if (parsed.type === "chat.session.ended") {
            setSessionId(null);
            setMessages([]);
            setIsTyping(false);
            setRemoteTyping(false);
            lastMessageIdRef.current = null;
          }
        } catch {
          // Ignore parse errors
        }
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "chat_tab_unmount");
      }
    };
  }, [sessionId, companyId, agent.id, addMessageIfNew]);

  // Fallback: slow REST polling to catch any missed messages
  useEffect(() => {
    if (!sessionId) return;

    const poll = async () => {
      try {
        const result = await agentsApi.chatMessages(agent.id, lastMessageIdRef.current ?? undefined, companyId);
        const newMessages = (result as { messages: ChatMessage[] }).messages;
        for (const msg of newMessages) {
          addMessageIfNew(msg);
        }
      } catch {
        // Silently ignore poll errors
      }
    };

    pollIntervalRef.current = setInterval(poll, 5000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [sessionId, agent.id, companyId, addMessageIfNew]);

  // ── File upload helper ────────────────────────────────────────────

  const uploadFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        setUploadingCount((c) => c + 1);
        try {
          const asset: AssetImage = await assetsApi.uploadImage(companyId, file, "chat");
          const pending: PendingAttachment = {
            assetId: asset.assetId,
            contentPath: asset.contentPath,
            contentType: asset.contentType,
            originalFilename: asset.originalFilename,
          };
          // Create a local preview URL for images
          if (isImageType(file.type)) {
            pending.previewUrl = URL.createObjectURL(file);
          }
          setPendingAttachments((prev) => [...prev, pending]);
        } catch {
          // Silently skip failed uploads
        } finally {
          setUploadingCount((c) => c - 1);
        }
      }
      inputRef.current?.focus();
    },
    [companyId],
  );

  // ── Clipboard paste handler ───────────────────────────────────────

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
      }
    },
    [uploadFiles],
  );

  // ── File input change handler ─────────────────────────────────────

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        void uploadFiles(Array.from(files));
      }
      // Reset so re-selecting the same file triggers onChange again
      e.target.value = "";
    },
    [uploadFiles],
  );

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      for (const att of pendingAttachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: async ({ content, attachments }: { content: string; attachments: PendingAttachment[] }) => {
      const attachmentIds = attachments.length > 0 ? attachments.map((a) => a.assetId) : undefined;
      const msg = await agentsApi.sendChatMessage(agent.id, content, companyId, attachmentIds);
      return { msg: msg as ChatMessage, attachments };
    },
    onSuccess: ({ msg, attachments }) => {
      // Attach the pending attachments to the local message for immediate rendering
      const enrichedMsg: ChatMessage = {
        ...msg,
        attachments:
          attachments.length > 0
            ? attachments.map((a) => ({
                assetId: a.assetId,
                contentPath: a.contentPath,
                contentType: a.contentType,
                originalFilename: a.originalFilename,
              }))
            : undefined,
      };
      setMessages((prev) => {
        if (prev.some((m) => m.id === enrichedMsg.id)) return prev;
        return [...prev, enrichedMsg];
      });
      lastMessageIdRef.current = enrichedMsg.id;
      if (!sessionId) {
        setSessionId(enrichedMsg.sessionId);
      }
      setIsTyping(true);
      setInput("");
      // Clear user typing signal on send
      signalTyping(false);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      // Revoke preview URLs
      for (const att of attachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      setPendingAttachments([]);
      inputRef.current?.focus();
    },
  });

  // End session
  const endMutation = useMutation({
    mutationFn: () => agentsApi.endChatSession(agent.id, companyId),
    onSuccess: () => {
      setSessionId(null);
      setMessages([]);
      setIsTyping(false);
      setRemoteTyping(false);
      lastMessageIdRef.current = null;
      setPendingAttachments([]);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    },
  });

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if ((!trimmed && pendingAttachments.length === 0) || sendMutation.isPending) return;
    sendMutation.mutate({ content: trimmed || "(attachment)", attachments: [...pendingAttachments] });
  }, [input, pendingAttachments, sendMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const removePendingAttachment = useCallback((idx: number) => {
    setPendingAttachments((prev) => {
      const removed = prev[idx];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSelectHistorySession = useCallback((id: string) => {
    if (id === "") {
      // Back to active session
      setViewingHistoryId(null);
    } else {
      setViewingHistoryId(id);
    }
    setMobileHistoryOpen(false);
  }, []);

  // If viewing a past session, render the read-only history viewer
  const showHistoryViewer = viewingHistoryId !== null;

  return (
    <div className="flex h-[calc(100vh-12rem)] gap-0">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 max-w-3xl">
        {showHistoryViewer ? (
          <ChatHistoryViewer
            agent={agent}
            companyId={companyId}
            sessionId={viewingHistoryId}
            onBack={() => setViewingHistoryId(null)}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MessageSquare className="h-4 w-4" />
                <span>{sessionId ? "Chat session active" : "Start a conversation"}</span>
              </div>
              <div className="flex items-center gap-1">
                {/* Mobile history toggle — visible only below lg breakpoint */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMobileHistoryOpen(true)}
                  className="lg:hidden text-xs text-muted-foreground"
                >
                  <History className="h-3.5 w-3.5 mr-1" />
                  History
                </Button>
                {sessionId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => endMutation.mutate()}
                    disabled={endMutation.isPending}
                    className="text-xs text-muted-foreground"
                  >
                    <X className="h-3 w-3 mr-1" />
                    End session
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto py-4 space-y-3">
              {messages.length === 0 && !sessionId && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm">
                  <MessageSquare className="h-8 w-8 mb-3 opacity-40" />
                  <p>Send a message to start chatting with {agent.name}.</p>
                  <p className="text-xs mt-1 opacity-70">Chat sessions are saved to history automatically.</p>
                </div>
              )}

              {messages.map((msg) => (
                <div key={msg.id} className={cn("flex", msg.sender === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                      msg.sender === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                    )}
                  >
                    {msg.sender === "agent" ? (
                      <MarkdownBody className="text-sm">{msg.content}</MarkdownBody>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <MessageAttachments attachments={msg.attachments} isUser={msg.sender === "user"} />
                    )}
                    <span className="flex items-center gap-1 text-[10px] opacity-50 mt-1">
                      {new Date(msg.createdAt).toLocaleTimeString()}
                      {msg.sender === "user" && msg.readAt && <CheckCheck className="h-3 w-3 text-blue-400" />}
                    </span>
                  </div>
                </div>
              ))}

              {/* User typing indicator (from the other side) */}
              {remoteTyping && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="flex gap-0.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                      </span>
                    </span>
                  </div>
                </div>
              )}

              {isTyping && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] bg-muted rounded-lg text-sm text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => setThinkingOpen((o) => !o)}
                      className="flex items-center gap-1.5 px-3 py-2 w-full text-left hover:bg-muted/80 rounded-lg transition-colors"
                    >
                      <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                      <span className="flex-1">{agent.name} is thinking...</span>
                      {transcript.length > 0 &&
                        (thinkingOpen ? (
                          <ChevronDown className="h-3 w-3 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 flex-shrink-0" />
                        ))}
                    </button>
                    {thinkingOpen && transcript.length > 0 && (
                      <div className="px-3 pb-2 max-h-[300px] overflow-y-auto border-t border-border/50">
                        <RunTranscriptView
                          entries={transcript}
                          density="compact"
                          streaming
                          collapseStdout
                          thinkingClassName="!text-[10px] !leading-4"
                          emptyMessage=""
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border pt-3">
              {/* Pending attachment previews */}
              {(pendingAttachments.length > 0 || uploadingCount > 0) && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingAttachments.map((att, idx) => (
                    <PendingAttachmentChip key={att.assetId} att={att} onRemove={() => removePendingAttachment(idx)} />
                  ))}
                  {uploadingCount > 0 && (
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Uploading...
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-end gap-2">
                {/* Hidden file input */}
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
                {/* Attach button */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-[38px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingCount > 0}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    handleTypingInput();
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={`Message ${agent.name}...`}
                  rows={1}
                  className={cn(
                    "flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm",
                    "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    "min-h-[38px] max-h-[120px]",
                  )}
                  style={{ height: "auto" }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                  }}
                />
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={(!input.trim() && pendingAttachments.length === 0) || sendMutation.isPending}
                  className="h-[38px] px-3"
                >
                  {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              {sendMutation.isError && (
                <p className="text-xs text-destructive mt-1">Failed to send message. Try again.</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* History sidebar — desktop only */}
      <div className="hidden lg:flex w-64 min-w-0 flex-shrink-0 border-l border-border ml-4 overflow-hidden">
        <ChatHistorySidebar
          agent={agent}
          companyId={companyId}
          activeSessionId={sessionId}
          onSelectSession={handleSelectHistorySession}
          viewingHistoryId={viewingHistoryId}
        />
      </div>

      {/* Mobile history sheet */}
      <Sheet open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
        <SheetContent side="right" className="w-72 p-0 lg:hidden">
          <SheetTitle className="sr-only">Chat History</SheetTitle>
          <ChatHistorySidebar
            agent={agent}
            companyId={companyId}
            activeSessionId={sessionId}
            onSelectSession={handleSelectHistorySession}
            viewingHistoryId={viewingHistoryId}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
