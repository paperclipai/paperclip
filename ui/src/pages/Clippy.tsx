import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany } from "../context/CompanyContext";
import { chatApi, type ChatSession } from "../api/chat";
import { ClippyConversation } from "../components/ClippyConversation";
import { cn } from "../lib/utils";

export function Clippy() {
  const qc = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const sessionsQuery = useQuery({
    queryKey: ["clippy", "sessions"],
    queryFn: () => chatApi.listSessions().then((r) => r.sessions),
  });
  const sessions = sessionsQuery.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  // Default to most-recent session on first load.
  useEffect(() => {
    if (activeId) return;
    if (sessions.length > 0) setActiveId(sessions[0].id);
  }, [activeId, sessions]);

  const createMutation = useMutation({
    mutationFn: () =>
      chatApi.createSession({ companyId: selectedCompanyId ?? null }).then((r) => r.session),
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      setActiveId(session.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => chatApi.deleteSession(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      if (activeId === deletedId) setActiveId(null);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      chatApi.patchSession(id, { title }).then((r) => r.session),
    onSuccess: (session) => {
      qc.setQueryData(["clippy", "session", session.id], session);
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
    },
  });

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageSquare className="h-4 w-4" />
            Clippy
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <Plus className="mr-1 h-3 w-3" /> New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">No chats yet.</div>
          )}
          <ul className="flex flex-col">
            {sessions.map((s) => (
              <SessionRailItem
                key={s.id}
                session={s}
                active={s.id === activeId}
                onClick={() => setActiveId(s.id)}
                onDelete={() => deleteMutation.mutate(s.id)}
                onRename={(title) => renameMutation.mutate({ id: s.id, title })}
              />
            ))}
          </ul>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <ClippyConversation sessionId={activeId} />
      </main>
    </div>
  );
}

function SessionRailItem({
  session,
  active,
  onClick,
  onDelete,
  onRename,
}: {
  session: ChatSession;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!renaming) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [renaming]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== session.title) {
      onRename(trimmed);
    }
    setRenaming(false);
  };

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-2 px-3 py-2 text-xs",
          active ? "bg-accent" : "hover:bg-accent/50",
        )}
      >
        {renaming ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(session.title);
                setRenaming(false);
              }
            }}
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            aria-label="Rename chat"
          />
        ) : (
          <button
            type="button"
            onClick={onClick}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(session.title);
              setRenaming(true);
            }}
            className="min-w-0 flex-1 truncate text-left"
            title={`${session.title} — double-click to rename`}
          >
            <div className="truncate font-medium">{session.title}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {session.mode === "agent" ? "Agent" : "Chat"} · {session.model}
            </div>
          </button>
        )}
        {!renaming && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDraft(session.title);
                setRenaming(true);
              }}
              className="invisible text-muted-foreground hover:text-foreground group-hover:visible"
              title="Rename"
              aria-label="Rename chat"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${session.title}"?`)) onDelete();
              }}
              className="invisible text-muted-foreground hover:text-foreground group-hover:visible"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
