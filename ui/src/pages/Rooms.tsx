import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Send, Trash2, Check, CheckCheck, X, Zap, Paperclip, FileIcon, Download } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { roomsApi, type Room, type RoomMessage, type RoomParticipant, type RoomAttachment } from "../api/rooms";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

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
    return (
      <div className={cn("rounded-md border px-3 py-2 text-[13px] inline-block max-w-full", statusClass)}>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold mb-1">
          {statusIcon}
          <span>Action → {agentName(m.actionTargetAgentId)}</span>
          <span className="ml-2 opacity-70">{m.actionStatus}</span>
        </div>
        {m.body && <div className="text-foreground/90 text-[14px]">{m.body}</div>}
        {m.attachments && <Attachments list={m.attachments} />}
        {m.actionStatus === "pending" && (
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2"
              onClick={() =>
                updateActionStatusMutation.mutate({ id: m.id, status: "executed" })
              }
            >
              <Check className="h-3 w-3 mr-1" /> Mark executed
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2"
              onClick={() =>
                updateActionStatusMutation.mutate({ id: m.id, status: "failed" })
              }
            >
              <X className="h-3 w-3 mr-1" /> Mark failed
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      {m.body && (
        <div className="text-[14px] text-foreground/90 leading-relaxed break-words whitespace-pre-wrap">
          {m.body}
        </div>
      )}
      {m.attachments && <Attachments list={m.attachments} />}
    </div>
  );
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
    <div className="max-w-2xl mx-auto p-8">
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

  const messages = useQuery({
    queryKey: ["room-messages", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listMessages(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    // 300ms polling gives chat-like UX without the complexity of a
    // per-socket room membership cache. Phase 3c (WS push) can replace
    // this once the backplane/fan-out story is decided.
    refetchInterval: 300,
    placeholderData: keepPreviousData,
  });

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

  const session = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.data?.length]);

  const [body, setBody] = useState("");
  const [msgType, setMsgType] = useState<"text" | "action">("text");
  const [actionTarget, setActionTarget] = useState<string>("");
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
      alert(`Upload failed: ${err?.message ?? String(err)}`);
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: () =>
      roomsApi.sendMessage(selectedCompanyId!, roomId!, {
        type: msgType,
        body,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : null,
        actionTargetAgentId: msgType === "action" ? actionTarget || null : null,
        actionPayload: msgType === "action" ? { source: "ui" } : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["room-messages", selectedCompanyId, roomId] });
      setBody("");
      setPendingAttachments([]);
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
    const msgs = messages.data ?? [];
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
  }, [messages.data, allAgents.data]);

  const linkedAgentIds = new Set(
    (participants.data ?? []).map((p: RoomParticipant) => p.agentId).filter((x): x is string => !!x),
  );
  const linkableAgents = (allAgents.data ?? []).filter((a: any) => !linkedAgentIds.has(a.id));

  if (!room.data) return <div className="p-8 text-muted-foreground">Loading room...</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 h-[calc(100vh-80px)]">
      <div className="flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-bold flex-1">{room.data.name}</h1>
          <Button
            data-testid="room-archive"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm(`Archive "${room.data!.name}"?`)) archiveMutation.mutate();
            }}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Archive
          </Button>
        </div>
        {room.data.description && (
          <p className="text-sm text-muted-foreground mb-4">{room.data.description}</p>
        )}

        {/* === Messages (Slack/Mattermost pattern — all-left, grouped) === */}
        <div
          data-testid="room-messages"
          className="flex-1 overflow-y-auto py-2 pr-2 mb-3 min-h-0"
        >
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center mt-8">
              No messages yet
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
                ) : (
                  <div className="group/grp mt-3 first:mt-0">
                    {/* Group header: avatar + sender name + time, all-left */}
                    <div className="flex items-start gap-3 px-2 py-1 hover:bg-accent/20 rounded">
                      <div
                        className="shrink-0 h-9 w-9 rounded-md flex items-center justify-center text-[12px] font-bold text-white mt-0.5"
                        style={{ backgroundColor: g.senderColor }}
                        title={g.senderName}
                      >
                        {initials(g.senderName)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-0.5">
                          <span className="text-[14px] font-bold text-foreground">
                            {g.senderName}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatTime(g.firstAt)}
                          </span>
                        </div>
                        {/* First message body */}
                        {renderMessageBody(
                          g.messages[0],
                          agentName,
                          updateActionStatusMutation,
                        )}
                      </div>
                    </div>
                    {/* Continuation messages: no avatar, hover-only timestamp */}
                    {g.messages.slice(1).map((m) => (
                      <div
                        key={m.id}
                        className="flex items-start gap-3 px-2 py-0.5 hover:bg-accent/20 rounded group/msg"
                      >
                        <div className="shrink-0 h-0 w-9 relative">
                          <span className="absolute right-0 top-1 text-[10px] text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-opacity">
                            {formatTime(m.createdAt)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          {renderMessageBody(m, agentName, updateActionStatusMutation)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* === Compose === */}
        <div
          className={cn(
            "rounded-lg border border-border bg-background p-2 transition-colors",
            isDragging && "border-primary bg-primary/5",
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
            className="flex gap-2 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (body.trim() || pendingAttachments.length > 0) sendMessageMutation.mutate();
            }}
          >
            <select
              data-testid="room-msg-type"
              className="text-sm border border-border rounded px-2 py-1 bg-background h-9"
              value={msgType}
              onChange={(e) => setMsgType(e.target.value as any)}
            >
              <option value="text">text</option>
              <option value="action">action</option>
            </select>
            {msgType === "action" && (
              <select
                data-testid="room-action-target"
                className="text-sm border border-border rounded px-2 py-1 bg-background h-9"
                value={actionTarget}
                onChange={(e) => setActionTarget(e.target.value)}
                required
              >
                <option value="">target agent…</option>
                {(allAgents.data ?? []).map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
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
            <button
              type="button"
              data-testid="room-attach-button"
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9 flex items-center justify-center rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <Input
              data-testid="room-msg-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onPaste={handlePaste}
              placeholder={
                isDragging
                  ? "Drop files to attach…"
                  : msgType === "action"
                    ? "Action description..."
                    : "Type a message, paste or drop files…"
              }
              className="flex-1 h-9"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!body.trim() && pendingAttachments.length === 0}
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>

      {/* === Sidebar: participants + linked issues === */}
      <div className="space-y-6">
        <section data-testid="room-participants-section">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            Participants ({participants.data?.length ?? 0})
          </h3>
          <ul className="space-y-1 mb-2">
            {(participants.data ?? []).map((p) => (
              <li
                key={p.id}
                className="text-xs flex items-center gap-2 border border-border rounded px-2 py-1"
              >
                <Badge variant="outline" className="text-[10px]">
                  {p.role}
                </Badge>
                <span className="flex-1 truncate">
                  {p.agentId ? agentName(p.agentId) : p.userId}
                </span>
                <button
                  onClick={() => removeParticipantMutation.mutate(p.id)}
                  aria-label={`remove participant ${p.id}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
          <select
            data-testid="room-add-participant"
            className="w-full text-xs border border-border rounded px-2 py-1 bg-background"
            onChange={(e) => {
              if (e.target.value) {
                addParticipantMutation.mutate(e.target.value);
                e.target.value = "";
              }
            }}
            defaultValue=""
          >
            <option value="">+ Add agent…</option>
            {linkableAgents.map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </section>

        <section data-testid="room-issues-section">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
            Linked Issues ({issues.data?.length ?? 0})
          </h3>
          <ul className="space-y-1">
            {(issues.data ?? []).map((link) => (
              <li
                key={link.issueId}
                className="text-xs flex items-center gap-2 border border-border rounded px-2 py-1"
              >
                <span className="font-mono">{link.issue.identifier ?? "—"}</span>
                <span className="flex-1 truncate">{link.issue.title}</span>
              </li>
            ))}
            {(issues.data ?? []).length === 0 && (
              <li className="text-xs text-muted-foreground italic">No issues linked</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
