import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { roomsApi, type RoomMessage, type RoomParticipant } from "../api/rooms";
import { agentsApi } from "../api/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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

  const room = useQuery({
    queryKey: ["room", selectedCompanyId, roomId],
    queryFn: () => roomsApi.get(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
  });

  const messages = useQuery({
    queryKey: ["room-messages", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listMessages(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
    refetchInterval: 3_000,
  });

  const participants = useQuery({
    queryKey: ["room-participants", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listParticipants(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
  });

  const issues = useQuery({
    queryKey: ["room-issues", selectedCompanyId, roomId],
    queryFn: () => roomsApi.listIssues(selectedCompanyId!, roomId!),
    enabled: !!selectedCompanyId && !!roomId,
  });

  const allAgents = useQuery({
    queryKey: ["agents-for-room", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.data?.length]);

  const [body, setBody] = useState("");
  const [msgType, setMsgType] = useState<"text" | "action">("text");
  const [actionTarget, setActionTarget] = useState<string>("");

  const sendMessageMutation = useMutation({
    mutationFn: () =>
      roomsApi.sendMessage(selectedCompanyId!, roomId!, {
        type: msgType,
        body,
        actionTargetAgentId: msgType === "action" ? actionTarget || null : null,
        actionPayload: msgType === "action" ? { source: "ui" } : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["room-messages", selectedCompanyId, roomId] });
      setBody("");
    },
  });

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

  if (!room.data) return <div className="p-8 text-muted-foreground">Loading room...</div>;

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

  const linkedAgentIds = new Set(
    (participants.data ?? []).map((p: RoomParticipant) => p.agentId).filter((x): x is string => !!x),
  );
  const linkableAgents = (allAgents.data ?? []).filter((a: any) => !linkedAgentIds.has(a.id));

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

        {/* === Messages === */}
        <div
          data-testid="room-messages"
          className="flex-1 overflow-y-auto border border-border rounded p-3 mb-3 bg-card/30 space-y-2 min-h-0"
        >
          {(messages.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No messages yet</p>
          ) : (
            (messages.data ?? []).map((m) => (
              <div key={m.id} className="text-sm border border-border rounded p-2">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-xs">
                    {m.type}
                  </Badge>
                  <span className="font-medium">{senderName(m)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <div>{m.body}</div>
                {m.type === "action" && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <span>→ {agentName(m.actionTargetAgentId)}</span>
                    <Badge>{m.actionStatus}</Badge>
                    {m.actionStatus === "pending" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-xs"
                          onClick={() =>
                            updateActionStatusMutation.mutate({
                              id: m.id,
                              status: "executed",
                            })
                          }
                        >
                          Mark executed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-xs"
                          onClick={() =>
                            updateActionStatusMutation.mutate({
                              id: m.id,
                              status: "failed",
                            })
                          }
                        >
                          Mark failed
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* === Compose === */}
        <form
          className="flex gap-2 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) sendMessageMutation.mutate();
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
          <Input
            data-testid="room-msg-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={msgType === "action" ? "Action description..." : "Type a message..."}
            className="flex-1 h-9"
          />
          <Button type="submit" size="sm" disabled={!body.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
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
