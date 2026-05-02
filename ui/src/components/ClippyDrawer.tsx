import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, MessageCircle, Plus, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "../context/CompanyContext";
import { chatApi, type ChatSession } from "../api/chat";
import { ClippyConversation } from "./ClippyConversation";
import { cn } from "../lib/utils";

const ACTIVE_SESSION_KEY = "paperclip.clippy.activeSessionId";
const DRAWER_WIDTH_KEY = "paperclip.clippy.drawerWidth";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 448;

function readActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeActiveSessionId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else window.localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function readDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(DRAWER_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= MIN_WIDTH) return parsed;
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

function writeDrawerWidth(px: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

function clampWidth(px: number): number {
  const max = typeof window !== "undefined" ? Math.max(MIN_WIDTH, window.innerWidth - 80) : 1200;
  return Math.min(Math.max(MIN_WIDTH, px), max);
}

function popOutChat() {
  if (typeof window === "undefined") return null;
  const features = "popup=yes,width=520,height=720,menubar=no,toolbar=no,location=no,status=no";
  return window.open("/clippy-popup", "paperclip-clippy", features);
}

export function ClippyDrawer() {
  const [open, setOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() =>
    readActiveSessionId(),
  );
  const [width, setWidth] = useState<number>(() => readDrawerWidth());
  const draggingRef = useRef(false);
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();

  useEffect(() => {
    writeActiveSessionId(activeSessionId);
  }, [activeSessionId]);

  // Re-fetch sessions when drawer opens or after a create. Useful for the
  // history dropdown so the user can switch to any prior chat.
  const sessionsQuery = useQuery({
    queryKey: ["clippy", "sessions"],
    queryFn: () => chatApi.listSessions().then((r) => r.sessions),
    enabled: open,
  });
  const sessions = useMemo<ChatSession[]>(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const createMutation = useMutation({
    mutationFn: (companyId: string | null | undefined) =>
      chatApi.createSession({ companyId: companyId ?? null }).then((r) => r.session),
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      setActiveSessionId(session.id);
    },
  });

  // When opened, ensure an active session exists.
  useEffect(() => {
    if (!open) return;
    if (activeSessionId) return;
    if (!sessionsQuery.data) return;
    if (sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    } else if (!createMutation.isPending) {
      createMutation.mutate(selectedCompanyId);
    }
  }, [open, activeSessionId, sessionsQuery.data, sessions, createMutation, selectedCompanyId]);

  // Resize handle: pointer-driven drag on the left edge of the drawer.
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const handleMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        // Drawer is anchored right; new width = window.right - pointer.x
        const next = clampWidth(window.innerWidth - ev.clientX);
        setWidth(next);
      };
      const handleUp = (ev: PointerEvent) => {
        draggingRef.current = false;
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
        writeDrawerWidth(width);
      };
      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
    },
    [width],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <>
      <Button
        variant="default"
        size="icon"
        className="fixed bottom-4 right-4 z-40 h-12 w-12 rounded-full shadow-lg"
        onClick={() => setOpen(true)}
        aria-label="Open Clippy"
        title="Open Clippy"
      >
        <MessageCircle className="h-5 w-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          style={{ width: `${width}px`, maxWidth: "100vw" }}
          className="flex flex-col gap-0 p-0 sm:max-w-none"
        >
          {/* Resize handle on the left edge */}
          <div
            onPointerDown={onResizePointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Clippy drawer"
            className={cn(
              "absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize",
              "hover:bg-primary/40",
              draggingRef.current ? "bg-primary/60" : "bg-transparent",
            )}
          />
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="-ml-1 h-7 max-w-[180px] gap-1 px-2">
                  <span className="truncate text-sm font-semibold">
                    {activeSession?.title ?? "Clippy"}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {sessions.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet.</div>
                )}
                {sessions.slice(0, 12).map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => setActiveSessionId(s.id)}
                    className={cn("flex flex-col items-start gap-0", s.id === activeSessionId && "bg-accent")}
                  >
                    <span className="w-full truncate text-sm">{s.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {s.mode === "agent" ? "Agent" : "Chat"} · {s.model}
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    if (typeof window !== "undefined") window.location.assign("/clippy");
                  }}
                >
                  View all chats…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => createMutation.mutate(selectedCompanyId)}
                disabled={createMutation.isPending}
                title="Start a new chat"
              >
                <Plus className="mr-1 h-3 w-3" /> New
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  const win = popOutChat();
                  // Only collapse the drawer once the popup actually opened —
                  // if a popup blocker rejected it, leave the drawer open so
                  // the user isn't dropped into nothing.
                  if (win) setOpen(false);
                }}
                title="Pop out into its own window"
                aria-label="Pop out into its own window"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <ClippyConversation sessionId={activeSessionId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
