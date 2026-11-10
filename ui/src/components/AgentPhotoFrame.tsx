import { agentAvatarFocus, type AgentAppearance, type AgentAvatarFocus, type CharacterState } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { agentsApi } from "../api/agents";
import { describeError } from "../api/errors";
import { avatarFocusFromDrag } from "../lib/agent-photo-focus";
import { cn } from "@/lib/utils";
import { AgentCharacter } from "./AgentCharacter";

function capturePointer(element: HTMLElement, pointerId: number) {
  try { element.setPointerCapture(pointerId); } catch { return; }
}

function releasePointer(element: HTMLElement, pointerId: number) {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch { return; }
}

export type AgentPhotoAgent = {
  id: string;
  companyId: string;
  name: string;
  status?: string;
  appearance?: AgentAppearance | null;
};

type PhotoEditor = {
  error: string | null;
  movable: boolean;
  clearError: () => void;
};

const AgentPhotoEditorContext = createContext<PhotoEditor | null>(null);

export function useAgentPhotoEditorState() {
  return useContext(AgentPhotoEditorContext);
}

export function AgentPhotoEditor({ agent, children }: { agent: AgentPhotoAgent; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [movable, setMovable] = useState(false);
  return (
    <AgentPhotoEditorContext.Provider value={{ error, movable, clearError: () => setError(null) }}>
      <AgentPhotoDrag agent={agent} onError={setError} onMovable={setMovable}>{children}</AgentPhotoDrag>
    </AgentPhotoEditorContext.Provider>
  );
}

function AgentPhotoDrag({ agent, onError, onMovable, children }: { agent: AgentPhotoAgent; onError: (error: string | null) => void; onMovable: (movable: boolean) => void; children: ReactNode }) {
  const queryClient = useQueryClient();
  const assetId = agent.appearance?.customAvatarAssetId ?? null;
  const locked = agent.status === "terminated" || agent.status === "pending_approval";
  const saved = agentAvatarFocus(agent.appearance);
  const [draft, setDraft] = useState<AgentAvatarFocus | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: AgentAvatarFocus; container: number } | null>(null);
  const savedRef = useRef(saved);
  const focusRef = useRef(saved);
  const pendingRef = useRef(false);
  const keyboardTimer = useRef<number | null>(null);
  const focus = draft ?? saved;
  savedRef.current = saved;
  focusRef.current = focus;
  const movable = Boolean(assetId) && !locked && natural !== null && Math.max(natural.width, natural.height) / Math.min(natural.width, natural.height) > 1.02;
  const preview = agent.appearance && assetId ? { ...agent.appearance, avatarFocus: focus } : agent.appearance;

  useEffect(() => { setDraft(null); }, [assetId]);
  useEffect(() => { onMovable(movable); }, [movable, onMovable]);
  useEffect(() => {
    if (!assetId) { setNatural(null); return; }
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setNatural({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.src = `/api/assets/${assetId}/content`;
    return () => { cancelled = true; };
  }, [assetId]);
  useEffect(() => () => { if (keyboardTimer.current !== null) window.clearTimeout(keyboardTimer.current); }, []);

  const mutation = useMutation({
    mutationFn: (next: AgentAvatarFocus) => agentsApi.setAvatarFocus(agent.companyId, agent.id, next),
    onSuccess: async () => {
      onError(null);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      setDraft(null);
    },
    onError: (error) => {
      setDraft(null);
      onError(describeError(error, { action: "center the agent photo" }).body);
    },
  });
  pendingRef.current = mutation.isPending;

  function commit(next: AgentAvatarFocus) {
    if (pendingRef.current) return;
    const current = savedRef.current;
    if (Math.abs(next.x - current.x) < 0.05 && Math.abs(next.y - current.y) < 0.05) {
      setDraft(null);
      return;
    }
    focusRef.current = next;
    setDraft(next);
    mutation.mutate(next);
  }

  function focusAt(origin: AgentAvatarFocus, deltaX: number, deltaY: number, container: number) {
    if (!natural) return origin;
    return avatarFocusFromDrag({
      start: origin, deltaX, deltaY, containerSize: container, imageWidth: natural.width, imageHeight: natural.height,
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!movable || mutation.isPending || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: focusRef.current, container: rect.width };
    capturePointer(event.currentTarget, event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    setDraft(focusAt(current.origin, event.clientX - current.x, event.clientY - current.y, current.container));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    const next = focusAt(current.origin, event.clientX - current.x, event.clientY - current.y, current.container);
    if (next.x === current.origin.x && next.y === current.origin.y) { setDraft(null); return; }
    commit(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!movable || mutation.isPending || !natural) return;
    const step = event.currentTarget.getBoundingClientRect().width * 0.08;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = focusAt(focusRef.current, delta[0], delta[1], event.currentTarget.getBoundingClientRect().width);
    focusRef.current = next;
    setDraft(next);
    if (keyboardTimer.current !== null) window.clearTimeout(keyboardTimer.current);
    keyboardTimer.current = window.setTimeout(() => commit(next), 250);
  }

  return (
    <AgentPhotoFrameContext.Provider value={{ agent: { ...agent, appearance: preview }, movable, pending: mutation.isPending, onPointerDown, onPointerMove, onPointerUp, onKeyDown }}>
      {children}
    </AgentPhotoFrameContext.Provider>
  );
}

type FrameBindings = {
  agent: AgentPhotoAgent;
  movable: boolean;
  pending: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

const AgentPhotoFrameContext = createContext<FrameBindings | null>(null);

export function AgentPhotoFrame({ state, className }: { state: CharacterState; className?: string }) {
  const frame = useContext(AgentPhotoFrameContext);
  if (!frame) return null;
  const focus = agentAvatarFocus(frame.agent.appearance);
  return (
    <div
      data-testid="agent-photo-frame"
      className={cn("shrink-0 rounded-full", frame.movable && "cursor-grab touch-none select-none focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring")}
      tabIndex={frame.movable ? 0 : undefined}
      role={frame.movable ? "group" : "img"}
      aria-label={frame.movable
        ? `Center photo. Drag to move it, or use arrow keys. Currently ${Math.round(focus.x)}% across and ${Math.round(focus.y)}% down.`
        : `${frame.agent.name} avatar`}
      aria-busy={frame.pending || undefined}
      onPointerDown={frame.onPointerDown}
      onPointerMove={frame.onPointerMove}
      onPointerUp={frame.onPointerUp}
      onPointerCancel={frame.onPointerUp}
      onKeyDown={frame.onKeyDown}
    >
      <AgentCharacter agent={frame.agent} state={state} size={128} className={className} trackingScope="page" followCursor />
    </div>
  );
}
