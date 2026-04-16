import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { quickNotesApi, type QuickNote, type QuickNoteThread } from "../api/quick-notes";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  StickyNote,
  X,
  Plus,
  Trash2,
  EyeOff,
  ChevronRight,
  Loader2,
  Sparkles,
  MessageSquare,
  Send,
} from "lucide-react";

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusIcon(status: string) {
  switch (status) {
    case "researching":
      return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
    case "has_suggestions":
      return <Sparkles className="h-3 w-3 text-amber-500" />;
    default:
      return null;
  }
}

export function QuickNotesModal() {
  const [open, setOpen] = useState(false);
  const [newNoteText, setNewNoteText] = useState("");
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: notes = [], isLoading } = useQuery({
    queryKey: queryKeys.quickNotes.list(selectedCompanyId ?? ""),
    queryFn: () => quickNotesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && open,
    refetchInterval: open ? 15000 : false,
  });

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.quickNotes.threads(expandedNoteId ?? ""),
    queryFn: () => quickNotesApi.listThreads(expandedNoteId!),
    enabled: Boolean(expandedNoteId) && open,
    refetchInterval: open && expandedNoteId ? 10000 : false,
  });

  const createNote = useMutation({
    mutationFn: (text: string) => quickNotesApi.create(selectedCompanyId!, { text }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickNotes.list(selectedCompanyId!) });
      setNewNoteText("");
    },
  });

  const dismissNote = useMutation({
    mutationFn: (noteId: string) => quickNotesApi.update(noteId, { dismissed: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickNotes.list(selectedCompanyId!) });
    },
  });

  const deleteNote = useMutation({
    mutationFn: (noteId: string) => quickNotesApi.remove(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickNotes.list(selectedCompanyId!) });
      if (expandedNoteId) setExpandedNoteId(null);
    },
  });

  const addReply = useMutation({
    mutationFn: ({ noteId, body }: { noteId: string; body: string }) =>
      quickNotesApi.addThread(noteId, body),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickNotes.threads(vars.noteId) });
      setReplyText("");
    },
  });

  // Ctrl+Shift+P → toggle
  // Ctrl+Shift+P → toggle; also listen for programmatic open event (mobile nav)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "p" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    function handleOpenEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("paperclip:open-quick-notes", handleOpenEvent);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("paperclip:open-quick-notes", handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Toast for notes with suggestions (poll-based)
  const prevSuggestionCountRef = useRef(0);
  useEffect(() => {
    const withSuggestions = notes.filter((n) => n.status === "has_suggestions").length;
    if (withSuggestions > prevSuggestionCountRef.current && prevSuggestionCountRef.current > 0) {
      const newest = notes.find((n) => n.status === "has_suggestions");
      if (newest) {
        pushToast({
          title: "Note update",
          body: `Your note "${newest.text.slice(0, 60)}${newest.text.length > 60 ? "..." : ""}" — I found some suggestions. Check it out!`,
          tone: "info",
        });
      }
    }
    prevSuggestionCountRef.current = withSuggestions;
  }, [notes]);

  const handleAddNote = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newNoteText.trim();
      if (!trimmed || createNote.isPending) return;
      createNote.mutate(trimmed);
    },
    [newNoteText, createNote],
  );

  const handleReply = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!expandedNoteId || !replyText.trim() || addReply.isPending) return;
      addReply.mutate({ noteId: expandedNoteId, body: replyText.trim() });
    },
    [expandedNoteId, replyText, addReply],
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />

      {/* Panel — full screen on mobile, right slide-out on desktop */}
      <div className="fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-50 w-full md:max-w-md bg-card md:border-l border-border shadow-2xl flex flex-col pb-[env(safe-area-inset-bottom)]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] border-b border-border bg-muted/30 shrink-0">
          <StickyNote className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium flex-1">Quick Notes</span>
          <span className="text-xs text-muted-foreground hidden md:inline">Ctrl+Shift+P</span>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* New note input */}
        <form onSubmit={handleAddNote} className="px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={newNoteText}
              onChange={(e) => setNewNoteText(e.target.value)}
              placeholder="Jot down a thought, idea, or reminder..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              disabled={createNote.isPending}
            />
            <button
              type="submit"
              disabled={!newNoteText.trim() || createNote.isPending}
              className={cn(
                "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
                newNoteText.trim() && !createNote.isPending
                  ? "bg-primary text-primary-foreground hover:opacity-90"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </form>

        {/* Notes list / thread view */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading...
            </div>
          ) : expandedNoteId ? (
            // Thread view
            <NoteThreadView
              note={notes.find((n) => n.id === expandedNoteId)!}
              threads={threads}
              replyText={replyText}
              onReplyChange={setReplyText}
              onReplySubmit={handleReply}
              isReplying={addReply.isPending}
              onBack={() => {
                setExpandedNoteId(null);
                setReplyText("");
              }}
              onDelete={(id) => {
                deleteNote.mutate(id);
                setExpandedNoteId(null);
              }}
            />
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
              <StickyNote className="h-6 w-6 opacity-50" />
              <p>No notes yet. Start jotting things down!</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {notes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  onExpand={() => setExpandedNoteId(note.id)}
                  onDismiss={() => dismissNote.mutate(note.id)}
                  onDelete={() => deleteNote.mutate(note.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function NoteRow({
  note,
  onExpand,
  onDismiss,
  onDelete,
}: {
  note: QuickNote;
  onExpand: () => void;
  onDismiss: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group px-4 py-3 hover:bg-muted/30 transition-colors">
      <div className="flex items-start gap-2">
        <button onClick={onExpand} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            {statusIcon(note.status)}
            <span className="text-xs text-muted-foreground">{relativeTime(note.createdAt)}</span>
            {note.status === "has_suggestions" && (
              <span className="text-xs text-amber-600 font-medium">Has suggestions</span>
            )}
          </div>
          <p className="text-sm leading-snug">{note.text}</p>
        </button>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={onExpand}
            title="View thread"
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <EyeOff className="h-3 w-3" />
          </button>
          <button
            onClick={onDelete}
            title="Delete"
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-accent"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteThreadView({
  note,
  threads,
  replyText,
  onReplyChange,
  onReplySubmit,
  isReplying,
  onBack,
  onDelete,
}: {
  note: QuickNote;
  threads: QuickNoteThread[];
  replyText: string;
  onReplyChange: (v: string) => void;
  onReplySubmit: (e: React.FormEvent) => void;
  isReplying: boolean;
  onBack: () => void;
  onDelete: (id: string) => void;
}) {
  if (!note) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronRight className="h-4 w-4 rotate-180" />
        </button>
        <span className="text-sm font-medium flex-1 truncate">{note.text.slice(0, 80)}</span>
        <button
          onClick={() => onDelete(note.id)}
          className="text-muted-foreground hover:text-destructive"
          title="Delete note"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Original note */}
      <div className="px-4 py-3 bg-muted/20 border-b border-border shrink-0 max-h-32 overflow-y-auto">
        <p className="text-sm">{note.text}</p>
        <p className="text-xs text-muted-foreground mt-1">{relativeTime(note.createdAt)}</p>
      </div>

      {/* Thread messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
        {threads.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {note.status === "researching"
              ? "The assistant is researching this note..."
              : "No replies yet. The assistant will add suggestions here."}
          </p>
        ) : (
          threads.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                "rounded-lg px-3 py-2 text-sm",
                entry.authorType === "agent"
                  ? "bg-primary/10 border border-primary/20"
                  : "bg-muted/50 border border-border ml-8",
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-medium">
                  {entry.authorType === "agent" ? "Assistant" : "You"}
                </span>
                <span className="text-xs text-muted-foreground">{relativeTime(entry.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap">{entry.body}</p>
            </div>
          ))
        )}
      </div>

      {/* Reply input */}
      <form onSubmit={onReplySubmit} className="px-4 py-3 border-t border-border shrink-0">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={replyText}
            onChange={(e) => onReplyChange(e.target.value)}
            placeholder="Reply to this note..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            disabled={isReplying}
          />
          <button
            type="submit"
            disabled={!replyText.trim() || isReplying}
            className={cn(
              "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
              replyText.trim() && !isReplying
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
