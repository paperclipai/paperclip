import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Send, ArrowUp, Trash2, Check, CheckCheck, X, Zap, Paperclip, FileIcon, Download, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { roomsApi, type Room, type RoomMessage, type RoomParticipant, type RoomAttachment } from "../api/rooms";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageSkeleton } from "../components/PageSkeleton";
import { useT } from "../i18n";
import { useConfirm, useAlert } from "../context/ConfirmContext";
import type { TranslationKey } from "../i18n/en";

// Deterministic color from a string (user/agent id)
function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hues = [200, 280, 160, 340, 30, 260, 100, 220, 0, 180];
  return `hsl(${hues[Math.abs(hash) % hues.length]}, 55%, 55%)`;
}

function initials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Format "09:45" style (relative if today, else date)
function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

interface MessageGroup {
  key: string;
  senderKey: string;
  senderName: string;
  senderColor: string;
  firstAt: string;
  messages: RoomMessage[];
  dayHeader: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function Attachments({ list }: { list: RoomAttachment[] }) {
  if (!list || list.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-2">
      {list.map((a) => {
        const isImage = a.contentType.startsWith("image/");
        if (isImage) {
          return (
            <a key={a.assetId} href={a.url} target="_blank" rel="noreferrer" className="inline-block max-w-sm">
              <img
                src={a.url}
                alt={a.name}
                className="rounded-md border border-border max-h-64 object-cover hover:opacity-90 transition-opacity"
                loading="lazy"
              />
              <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                {a.name} · {formatBytes(a.size)}
              </div>
            </a>
          );
        }
        return (
          <a
            key={a.assetId}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-accent/30 hover:bg-accent/50 transition-colors text-[13px] max-w-sm"
            download={a.name}
          >
            <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{a.name}</span>
            <span className="text-[11px] text-muted-foreground shrink-0">{formatBytes(a.size)}</span>
            <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}

function renderMessageBody(
  m: RoomMessage,
  agentName: (id: string | null) => string,
  updateActionStatusMutation: {
    mutate: (args: { id: string; status: string }) => void;
  },
  approvalStatus: (approvalId: string | null | undefined) => string | null,
  t: (key: TranslationKey) => string,
) {
  if (m.type === "action") {
    const statusIcon =
      m.actionStatus === "executed" ? (
        <CheckCheck className="h-3 w-3" />
      ) : m.actionStatus === "failed" ? (
        <X className="h-3 w-3" />
      ) : (
        <Zap className="h-3 w-3 animate-pulse" />
      );
    const statusClass =
      m.actionStatus === "executed"
        ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
        : m.actionStatus === "failed"
          ? "text-destructive border-destructive/30 bg-destructive/10"
          : "text-amber-500 border-amber-500/30 bg-amber-500/10";

    // Phase 5.2f — gate badge + button state. A null approvalId means
    // the message was created without requiresApproval and the
    // existing ungated behavior applies. A non-null approvalId shows
    // the current state and disables Mark executed until approved.
    const gate = m.approvalId ? approvalStatus(m.approvalId) : null;
    const gateBadge =
      gate === "approved" ? (
        <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 text-[10px] font-medium">
          ✓ approved
        </span>
      ) : gate === "rejected" ? (
        <span className="ml-2 px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 text-[10px] font-medium">
          ✗ rejected
        </span>
      ) : m.approvalId ? (
        <span className="ml-2 px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 text-[10px] font-medium">
          ⏸ awaiting approval
        </span>
      ) : null;

    return (
      <div className={cn("rounded-md border px-3 py-2 text-[13px] inline-block max-w-full", statusClass)}>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold mb-1">
          {statusIcon}
          <span>Action → {agentName(m.actionTargetAgentId)}</span>
          <span className="ml-2 opacity-70">{m.actionStatus}</span>
          {gateBadge}
        </div>
        {m.body && <div className="text-foreground/90 text-[14px]">{m.body}</div>}
        {m.attachments && <Attachments list={m.attachments} />}
        {m.actionStatus === "executed" && m.actionResult && Object.keys(m.actionResult).length > 0 && (
          <pre className="mt-2 text-[11px] font-mono bg-background/40 border border-current/20 rounded px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(m.actionResult, null, 2)}
          </pre>
        )}
        {m.actionStatus === "failed" && m.actionError && (
          <div className="mt-2 text-[12px] font-mono text-destructive bg-background/40 border border-destructive/30 rounded px-2 py-1">
            {m.actionError}
          </div>
        )}
        {(m.actionStatus === "executed" || m.actionStatus === "failed") && m.actionExecutedAt && (
          <div className="mt-1 text-[10px] opacity-60">
            by {m.actionExecutedByAgentId
              ? agentName(m.actionExecutedByAgentId)
              : (m.actionExecutedByUserId ?? "system")}
            {" · "}
            {new Date(m.actionExecutedAt).toLocaleString()}
          </div>
        )}
        {m.actionStatus === "pending" && (
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2"
              disabled={
                !!m.approvalId && gate !== "approved"
              }
              title={
                m.approvalId && gate !== "approved"
                  ? t("room.requiresApproval").replace("{status}", gate ?? "pending")
                  : undefined
              }
              onClick={() =>
                updateActionStatusMutation.mutate({ id: m.id, status: "executed" })
              }
            >
              <Check className="h-3 w-3 mr-1" /> {t("room.markExecuted")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2"
              onClick={() =>
                updateActionStatusMutation.mutate({ id: m.id, status: "failed" })
              }
            >
              <X className="h-3 w-3 mr-1" /> {t("room.markFailed")}
            </Button>
            {m.approvalId && (
              <a
                href={`/approvals/${m.approvalId}`}
                className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {t("room.viewApproval")} →
              </a>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      {m.body && (
        <div className="text-[14px] text-foreground leading-relaxed break-words prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2 prose-code:before:content-none prose-code:after:content-none [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[13px] [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:font-mono">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
        </div>
      )}
      {m.attachments && <Attachments list={m.attachments} />}
    </div>
  );
}

/** Highlight @mentions and issue identifiers (e.g. DOG-1) in message text */
function highlightMentions(text: string): React.ReactNode {
  const parts = text.split(/(@\w+|[A-Z]{2,5}-\d+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (/^@\w+/.test(part)) {
      return (
        <span key={i} className="font-semibold text-blue-500 dark:text-blue-400">
          {part}
        </span>
      );
    }
    if (/^[A-Z]{2,5}-\d+$/.test(part)) {
      return (
        <span key={i} className="font-mono text-[13px] font-medium text-violet-500 dark:text-violet-400 cursor-pointer hover:underline">
          {part}
        </span>
      );
    }
    return part;
  });
}

export function NewRoomPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      roomsApi.create(selectedCompanyId!, {
        name,
        description: description || null,
      }),
    onSuccess: (room) => {
      qc.invalidateQueries({ queryKey: ["rooms", selectedCompanyId] });
      navigate(`/rooms/${room.id}`);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to create room"),
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">New Mission Room</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          createMutation.mutate();
        }}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <Input
            data-testid="room-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Engine Standup"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <Input
            data-testid="room-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Daily Engine team sync"
          />
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create Room"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export function RoomDetailPage() {
  const { t } = useT();
  const confirm = useConfirm();
  const showAlert = useAlert();
  const { roomId } = useParams<{ roomId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // keepPreviousData makes switching rooms flicker-free: the old room's
  // messages/participants stay on screen until the new room's data arrives.
  // Initial data pulled from the cached sidebar rooms list gives us
  // name/description/status with no HTTP roundtrip on first click.
  const sidebarRooms = qc.getQueryData<Room[]>(["rooms", selectedCompanyId]);
  const roomFromList = sidebarRooms?.find((r) => r.id === roomId) ?? null;

  const room = useQuery({
    queryKey: ["room", selectedCompanyId, roomId],
    queryFn: () => roomsApi.get(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    placeholderData: keepPreviousData,
    initialData: roomFromList ?? undefined,
    initialDataUpdatedAt: 0,
  });

  const [olderMessages, setOlderMessages] = useState<RoomMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Reset older messages when switching rooms
  useEffect(() => {
    setOlderMessages([]);
    setHasMore(true);
  }, [roomId]);

  const messages = useQuery({
    queryKey: ["room-messages", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listMessages(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    refetchInterval: 300,
    placeholderData: keepPreviousData,
  });

  const loadOlderMessages = async () => {
    if (!selectedCompanyId || !roomId || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const allCurrent = [...olderMessages, ...(messages.data ?? [])];
    const oldest = allCurrent[0];
    if (!oldest) { setLoadingOlder(false); return; }
    const older = await roomsApi.listMessages(selectedCompanyId, roomId, {
      limit: 50,
      before: oldest.createdAt,
    });
    if (older.length === 0) setHasMore(false);
    else setOlderMessages((prev) => [...older, ...prev]);
    setLoadingOlder(false);
  };

  const allMessages = useMemo(() => {
    const recent = messages.data ?? [];
    if (olderMessages.length === 0) return recent;
    // Deduplicate by id
    const seen = new Set(recent.map((m) => m.id));
    const unique = olderMessages.filter((m) => !seen.has(m.id));
    return [...unique, ...recent];
  }, [messages.data, olderMessages]);

  const participants = useQuery({
    queryKey: ["room-participants", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listParticipants(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    placeholderData: keepPreviousData,
  });

  const issues = useQuery({
    queryKey: ["room-issues", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listIssues(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    placeholderData: keepPreviousData,
  });

  const allAgents = useQuery({
    queryKey: ["agents-for-room", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Phase 5.2f — pull the company-wide approvals list so action message
  // cards can render the current gate state ("pending / approved /
  // rejected") and disable the Mark executed button until approved.
  // We refetch on the same interval as messages so the badge flips
  // within a few hundred ms of a sibling approving on another tab.
  const approvalsList = useQuery({
    queryKey: ["approvals-for-room", selectedCompanyId],
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 3000,
  });
  const approvalStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of approvalsList.data ?? []) {
      map.set(a.id, a.status);
    }
    return map;
  }, [approvalsList.data]);

  const session = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessageId = allMessages.length > 0 ? allMessages[allMessages.length - 1].id : null;
  // Auto-scroll when the newest message changes
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [latestMessageId]);

  const [body, setBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [msgType, setMsgType] = useState<"text" | "action">("text");
  const [actionTarget, setActionTarget] = useState<string>("");
  // Phase 5.2f UI polish — when a human composes an action message they
  // can tick this box to gate the "Mark executed" transition on a
  // companion `approvals` row. Only meaningful for action messages;
  // reset to false when the user flips back to text.
  const [requiresApproval, setRequiresApproval] = useState(false);

  // Routing hint: who will receive this message?
  const routingHint = useMemo(() => {
    const agents = (allAgents.data ?? []) as Array<{ id: string; name: string }>;
    const getName = (id: string) => agents.find((a) => a.id === id)?.name ?? null;
    // @all / @전체 / @모두
    if (/@(all|everyone|전체|모두)\b/i.test(body)) return { target: "전체", type: "all" as const };
    // @mention
    const mentionMatch = body.match(/@([\p{L}\p{N}_-]+)/u);
    if (mentionMatch) {
      const tok = mentionMatch[1].toLowerCase();
      const mentioned = agents.find((a) => a.name.toLowerCase() === tok);
      if (mentioned) return { target: mentioned.name, type: "mention" as const };
    }
    // coordinator fallback
    const coordId = room.data?.coordinatorAgentId;
    if (coordId) {
      const name = getName(coordId);
      if (name) return { target: name, type: "coordinator" as const };
    }
    // issue assignee fallback
    const linkedIssue = issues.data?.[0];
    if (linkedIssue?.issue) {
      const assigneeId = (linkedIssue.issue as any).assigneeAgentId;
      if (assigneeId) {
        const name = getName(assigneeId);
        if (name) return { target: name, type: "assignee" as const };
      }
    }
    return null;
  }, [body, allAgents.data, room.data?.coordinatorAgentId, issues.data]);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const agents = (allAgents.data ?? []) as Array<{ id: string; name: string }>;
    const participantIds = new Set(
      (participants.data ?? []).map((p: RoomParticipant) => p.agentId).filter(Boolean),
    );
    const roomAgents = agents.filter((a) => participantIds.has(a.id));
    if (!mentionQuery) return roomAgents;
    const q = mentionQuery.toLowerCase();
    return roomAgents.filter((a) => a.name.toLowerCase().includes(q));
  }, [mentionQuery, allAgents.data, participants.data]);

  const insertMention = (name: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    // Find the @ that started this mention
    const before = body.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) return;
    const newBody = body.slice(0, atIdx) + `@${name} ` + body.slice(cursor);
    setBody(newBody);
    setMentionQuery(null);
    setMentionIndex(0);
    // Restore focus + cursor
    setTimeout(() => {
      ta.focus();
      const pos = atIdx + name.length + 2;
      ta.setSelectionRange(pos, pos);
    }, 0);
  };
  const [pendingAttachments, setPendingAttachments] = useState<RoomAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFilesMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded: RoomAttachment[] = [];
      for (const f of files) {
        const att = await roomsApi.uploadAttachment(selectedCompanyId!, roomId!, f);
        uploaded.push(att);
      }
      return uploaded;
    },
    onSuccess: (atts) => {
      setPendingAttachments((prev) => [...prev, ...atts]);
    },
    onError: (err: any) => {
      showAlert({ description: `Upload failed: ${err?.message ?? String(err)}` });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: (capturedBody: string) =>
      roomsApi.sendMessage(selectedCompanyId!, roomId!, {
        type: msgType,
        body: capturedBody,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : null,
        actionTargetAgentId: msgType === "action" ? actionTarget || null : null,
        actionPayload: msgType === "action" ? { source: "ui" } : null,
        // Phase 5.2f — forward the approval gate flag. Server will
        // ignore (and the validator refine will 400) if set on a
        // non-action message, so we gate it on msgType here too.
        requiresApproval: msgType === "action" && requiresApproval,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["room-messages", selectedCompanyId, roomId] });
      setPendingAttachments([]);
      setRequiresApproval(false);
    },
  });

  const handleFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    uploadFilesMutation.mutate(arr);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  const addParticipantMutation = useMutation({
    mutationFn: (agentId: string) =>
      roomsApi.addParticipant(selectedCompanyId!, roomId!, { agentId }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["room-participants", selectedCompanyId, roomId] }),
  });

  const removeParticipantMutation = useMutation({
    mutationFn: (participantId: string) =>
      roomsApi.removeParticipant(selectedCompanyId!, roomId!, participantId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["room-participants", selectedCompanyId, roomId] }),
  });

  const updateActionStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      roomsApi.updateActionStatus(selectedCompanyId!, roomId!, id, status),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["room-messages", selectedCompanyId, roomId] }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => roomsApi.archive(selectedCompanyId!, roomId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rooms", selectedCompanyId] });
      navigate("/dashboard");
    },
  });

  const agentName = (id: string | null) => {
    if (!id) return "—";
    const a = (allAgents.data ?? []).find((x: any) => x.id === id);
    return a?.name ?? id.slice(0, 8);
  };

  const senderName = (m: RoomMessage) => {
    if (m.senderAgentId) return agentName(m.senderAgentId);
    if (m.senderUserId) return m.senderUserId;
    return "system";
  };

  const senderKeyOf = (m: RoomMessage) =>
    m.senderAgentId ? `a:${m.senderAgentId}` : m.senderUserId ? `u:${m.senderUserId}` : "system";

  // Group consecutive messages by sender within 5 minutes + day header
  const groups = useMemo<MessageGroup[]>(() => {
    const msgs = allMessages;
    const out: MessageGroup[] = [];
    let prevDay = "";
    for (const m of msgs) {
      if (m.type === "system") {
        const day = formatDayHeader(m.createdAt);
        out.push({
          key: `sys-${m.id}`,
          senderKey: "system",
          senderName: "system",
          senderColor: "hsl(0,0%,50%)",
          firstAt: m.createdAt,
          messages: [m],
          dayHeader: day !== prevDay ? day : null,
        });
        prevDay = day;
        continue;
      }
      const day = formatDayHeader(m.createdAt);
      const sKey = senderKeyOf(m);
      const last = out[out.length - 1];
      const sameSender = last && last.senderKey === sKey && last.senderKey !== "system";
      const withinWindow =
        last && new Date(m.createdAt).getTime() - new Date(last.messages[last.messages.length - 1].createdAt).getTime() < 5 * 60 * 1000;
      const sameDay = day === prevDay;
      if (sameSender && withinWindow && sameDay) {
        last.messages.push(m);
      } else {
        out.push({
          key: `grp-${m.id}`,
          senderKey: sKey,
          senderName: senderName(m),
          senderColor: colorFromId(sKey),
          firstAt: m.createdAt,
          messages: [m],
          dayHeader: day !== prevDay ? day : null,
        });
        prevDay = day;
      }
    }
    return out;
  }, [allMessages, allAgents.data]);

  const linkedAgentIds = new Set(
    (participants.data ?? []).map((p: RoomParticipant) => p.agentId).filter((x): x is string => !!x),
  );
  const linkableAgents = (allAgents.data ?? []).filter((a: any) => !linkedAgentIds.has(a.id));

  if (!room.data) return <PageSkeleton variant="detail" />;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 h-[calc(100vh-8rem)]">
      <div className="flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-bold flex-1">{room.data.name}</h1>
          <Button
            data-testid="room-archive"
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (await confirm({ description: t("room.archiveConfirm").replace("{name}", room.data!.name), variant: "destructive" })) archiveMutation.mutate();
            }}
          >
            <Trash2 className="h-4 w-4 mr-1" /> {t("room.archive")}
          </Button>
        </div>
        {room.data.description && (
          <p className="text-sm text-muted-foreground mb-4">{room.data.description}</p>
        )}

        {/* === Messages (Slack/Mattermost pattern — all-left, grouped) === */}
        <div
          ref={messagesContainerRef}
          data-testid="room-messages"
          className="flex-1 overflow-y-auto py-2 pr-2 mb-3 min-h-0"
        >
          {hasMore && allMessages.length > 0 && (
            <div className="flex justify-center py-3">
              <button
                onClick={loadOlderMessages}
                disabled={loadingOlder}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-4 py-1.5 rounded-full border border-border hover:bg-accent"
              >
                {loadingOlder ? "불러오는 중..." : "이전 메시지 더 보기"}
              </button>
            </div>
          )}
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center mt-8">
              {t("empty.noMessages")}
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                {g.dayHeader && (
                  <div className="flex items-center gap-3 my-4 px-2">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                      {g.dayHeader}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                )}
                {g.senderKey === "system" ? (
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground/80 italic px-14 py-1">
                    <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/50" />
                    {g.messages[0].body}
                    <span className="text-[10px]">
                      {formatTime(g.messages[0].createdAt)}
                    </span>
                  </div>
                ) : (() => {
                  const isMe = currentUserId != null && g.senderKey === `u:${currentUserId}`;
                  return isMe ? (
                    /* ── My messages: right-aligned with subtle bg ── */
                    <div className="group/grp mt-4 first:mt-0 flex flex-col items-end px-2">
                      <div className="max-w-[70%]">
                        <div className="flex items-baseline gap-2 mb-1 justify-end">
                          <span className="text-[11px] text-muted-foreground">
                            {formatTime(g.firstAt)}
                          </span>
                          <span className="text-[13px] font-semibold text-foreground">
                            {t("room.you")}
                          </span>
                        </div>
                        <div className="bg-primary/10 rounded-2xl rounded-tr-sm px-4 py-2.5">
                          {renderMessageBody(
                            g.messages[0],
                            agentName,
                            updateActionStatusMutation,
                            (id) => (id ? approvalStatusById.get(id) ?? null : null),
                            t,
                          )}
                        </div>
                        {g.messages.slice(1).map((m) => (
                          <div key={m.id} className="bg-primary/10 rounded-2xl rounded-tr-sm px-4 py-2.5 mt-1 group/msg">
                            {renderMessageBody(
                              m,
                              agentName,
                              updateActionStatusMutation,
                              (id) => (id ? approvalStatusById.get(id) ?? null : null),
                              t,
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* ── Other sender: left-aligned with avatar, Claude-style ── */
                    <div className="group/grp mt-4 first:mt-0">
                      <div className="flex items-start gap-3 px-2 py-1.5 rounded-lg hover:bg-accent/30 transition-colors">
                        <div
                          className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white mt-0.5 shadow-sm"
                          style={{ backgroundColor: g.senderColor }}
                          title={g.senderName}
                        >
                          {initials(g.senderName)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-[13px] font-semibold text-foreground">
                              {g.senderName}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {formatTime(g.firstAt)}
                            </span>
                          </div>
                          <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-4 py-2.5">
                            {renderMessageBody(
                              g.messages[0],
                              agentName,
                              updateActionStatusMutation,
                              (id) => (id ? approvalStatusById.get(id) ?? null : null),
                              t,
                            )}
                          </div>
                        </div>
                      </div>
                      {g.messages.slice(1).map((m) => (
                        <div
                          key={m.id}
                          className="flex items-start gap-3 px-2 py-0.5 rounded-lg group/msg"
                        >
                          <div className="shrink-0 h-0 w-8 relative">
                            <span className="absolute right-0 top-1 text-[10px] text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-opacity">
                              {formatTime(m.createdAt)}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-4 py-2.5">
                              {renderMessageBody(
                                m,
                                agentName,
                                updateActionStatusMutation,
                                (id) => (id ? approvalStatusById.get(id) ?? null : null),
                                t,
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* === Compose === */}
        <div
          className={cn(
            "p-2 transition-colors",
            isDragging && "bg-primary/5",
          )}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              handleFiles(e.dataTransfer.files);
            }
          }}
        >
          {/* Pending attachment chips */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 pb-2 border-b border-border">
              {pendingAttachments.map((a, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-2 py-1 rounded-md border border-border bg-accent/30 text-[12px] max-w-xs"
                >
                  {a.contentType.startsWith("image/") ? (
                    <img src={a.url} alt={a.name} className="h-8 w-8 rounded object-cover shrink-0" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingAttachments((prev) => prev.filter((_, i) => i !== idx))
                    }
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`remove ${a.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {uploadFilesMutation.isPending && (
                <span className="text-[11px] text-muted-foreground italic">Uploading...</span>
              )}
            </div>
          )}
          <form
            className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Mention dropdown */}
            {mentionQuery !== null && mentionCandidates.length > 0 && (
              <div className="border-b border-border px-2 py-1.5 max-h-40 overflow-y-auto">
                {mentionCandidates.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    className={cn(
                      "flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-md text-left transition-colors",
                      i === mentionIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault(); // Prevent textarea blur
                      insertMention(a.name);
                    }}
                  >
                    <span className="font-medium">@{a.name}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Routing hint */}
            {routingHint && (
              <div className="px-4 pt-2 pb-0">
                <span className="text-[10px] text-muted-foreground/60">
                  → {routingHint.target}에게 보내는 중
                </span>
              </div>
            )}
            {/* Textarea area */}
            <div className="px-4 pt-3 pb-2">
              <Textarea
                ref={textareaRef}
                data-testid="room-msg-body"
                value={body}
                onChange={(e) => {
                  const val = e.target.value;
                  setBody(val);
                  // Detect @mention
                  const cursor = e.target.selectionStart;
                  const before = val.slice(0, cursor);
                  const atMatch = before.match(/@(\w*)$/);
                  if (atMatch) {
                    setMentionQuery(atMatch[1]);
                    setMentionIndex(0);
                  } else {
                    setMentionQuery(null);
                  }
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (mentionQuery !== null && mentionCandidates.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      insertMention(mentionCandidates[mentionIndex].name);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionQuery(null);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!sendMessageMutation.isPending && (body.trim() || pendingAttachments.length > 0)) {
                      const msg = body;
                      setBody("");
                      setMentionQuery(null);
                      sendMessageMutation.mutate(msg);
                    }
                  }
                }}
                placeholder={
                  isDragging
                    ? "Drop files to attach…"
                    : msgType === "action"
                      ? "Action description..."
                      : t("room.compose")
                }
                className="w-full min-h-[44px] max-h-40 resize-none border-none bg-transparent p-0 text-[14px] placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none outline-none"
                rows={1}
              />
            </div>
            {/* Bottom toolbar */}
            <div className="flex items-center gap-1 px-3 pb-2.5 pt-0">
              {/* Left side controls */}
              <select
                data-testid="room-msg-type"
                className="text-[12px] text-muted-foreground bg-transparent border-0 rounded px-1.5 py-1 hover:bg-accent cursor-pointer focus:ring-0"
                value={msgType}
                onChange={(e) => setMsgType(e.target.value as any)}
              >
                <option value="text">text</option>
                <option value="action">action</option>
              </select>
              {msgType === "action" && (
                <>
                  <select
                    data-testid="room-action-target"
                    className="text-[12px] text-muted-foreground bg-transparent border-0 rounded px-1.5 py-1 hover:bg-accent cursor-pointer focus:ring-0"
                    value={actionTarget}
                    onChange={(e) => setActionTarget(e.target.value)}
                    required
                  >
                    <option value="">target…</option>
                    {(allAgents.data ?? []).map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground select-none cursor-pointer px-1">
                    <input
                      type="checkbox"
                      data-testid="room-requires-approval"
                      className="h-3 w-3 accent-amber-500"
                      checked={requiresApproval}
                      onChange={(e) => setRequiresApproval(e.target.checked)}
                    />
                    Approval
                  </label>
                </>
              )}
              <button
                type="button"
                data-testid="room-attach-button"
                onClick={() => fileInputRef.current?.click()}
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Attach file"
              >
                <Plus className="h-4 w-4" />
              </button>

              {/* Right side: send button */}
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={() => {
                    if (!sendMessageMutation.isPending && (body.trim() || pendingAttachments.length > 0)) {
                      const msg = body;
                      setBody("");
                      sendMessageMutation.mutate(msg);
                    }
                  }}
                  disabled={!body.trim() && pendingAttachments.length === 0}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center rounded-full transition-colors",
                    body.trim() || pendingAttachments.length > 0
                      ? "bg-foreground text-background hover:bg-foreground/90"
                      : "bg-muted text-muted-foreground cursor-not-allowed",
                  )}
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* === Sidebar: participants + linked issues === */}
      <div className="space-y-6">
        <section data-testid="room-participants-section">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            {t("room.participants")} ({participants.data?.length ?? 0})
          </h3>
          <div className="rounded-lg bg-card overflow-hidden mb-2">
            {(participants.data ?? []).map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors group"
              >
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 rounded-full">
                  {p.role}
                </Badge>
                <span className="flex-1 truncate text-foreground/80">
                  {p.agentId ? agentName(p.agentId) : p.userId}
                </span>
                <button
                  onClick={() => removeParticipantMutation.mutate(p.id)}
                  aria-label={`remove participant ${p.id}`}
                  className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {linkableAgents.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-xs text-muted-foreground h-7"
                >
                  <Plus className="h-3 w-3 mr-1.5" />
                  {t("room.addAgent")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1 max-h-60 overflow-y-auto" align="start">
                {linkableAgents.map((a: any) => (
                  <button
                    key={a.id}
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent/50 text-left"
                    onClick={() => addParticipantMutation.mutate(a.id)}
                  >
                    {a.name}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </section>

        <section data-testid="room-coordinator-section">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            {t("room.coordinator" as TranslationKey)}
          </h3>
          <select
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs"
            value={room.data?.coordinatorAgentId ?? ""}
            onChange={(e) => {
              const value = e.target.value || null;
              roomsApi.update(selectedCompanyId!, roomId!, { coordinatorAgentId: value } as any).then(() => {
                qc.invalidateQueries({ queryKey: ["room", selectedCompanyId, roomId] });
              });
            }}
          >
            <option value="">{t("room.coordinatorAuto" as TranslationKey)}</option>
            {(participants.data ?? [])
              .filter((p: RoomParticipant) => p.agentId)
              .map((p: RoomParticipant) => (
                <option key={p.agentId} value={p.agentId!}>
                  {agentName(p.agentId!)}
                </option>
              ))}
          </select>
          <p className="text-[10px] text-muted-foreground/50 mt-1">
            {t("room.coordinatorHint" as TranslationKey)}
          </p>
        </section>

        <section data-testid="room-issues-section">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            {t("room.linkedIssues")} ({issues.data?.length ?? 0})
          </h3>
          <div className="rounded-lg bg-card overflow-hidden">
            {(issues.data ?? []).map((link) => (
              <div
                key={link.issueId}
                className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground">{link.issue.identifier ?? "—"}</span>
                <span className="flex-1 truncate text-foreground/80">{link.issue.title}</span>
              </div>
            ))}
            {(issues.data ?? []).length === 0 && (
              <div className="px-3 h-7 flex items-center text-xs text-muted-foreground/60 italic">
                No issues linked
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
