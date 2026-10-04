import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { resolveAgentAppearance, type CharacterState } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { characterSlot } from "@/lib/agent-character-slot";
import { AgentAvatar, avatarSizeClasses, type AgentAvatarProps } from "./AgentAvatar";
import type { createCharacter } from "@paperclipai/shared/cliplab/runtime";

type Player = ReturnType<typeof createCharacter>;
export interface AgentCharacterProps extends Omit<AgentAvatarProps, "pose"> {
  state?: CharacterState;
  motion?: "auto" | "still";
  trackingRegion?: RefObject<HTMLElement | null>;
  trackingScope?: "region" | "page";
  followCursor?: boolean;
  followRotation?: boolean;
}
export function AgentCharacter({ agent, appearance, size = 256, state = "idle", muted = false, motion = "auto", trackingRegion, trackingScope = "region", followCursor = true, followRotation = true, className, label, name }: AgentCharacterProps) {
  const identity = useMemo(() => resolveAgentAppearance(appearance ?? agent?.appearance, agent?.id), [appearance, agent?.appearance, agent?.id]);
  const root = useRef<HTMLSpanElement>(null), host = useRef<HTMLSpanElement>(null), player = useRef<Player | null>(null);
  const slotId = useRef(Symbol("agent-character"));
  const owner = useSyncExternalStore(characterSlot.subscribe, characterSlot.getSnapshot, () => null);
  const [visible, setVisible] = useState(false), [reduced, setReduced] = useState(true), [failed, setFailed] = useState(false), [ready, setReady] = useState(false);
  const active = visible && !reduced && !failed && motion === "auto" && state !== "rest";
  useEffect(() => {
    if (typeof matchMedia !== "function" || typeof IntersectionObserver !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches); change(); media.addEventListener("change", change);
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
    if (root.current) observer.observe(root.current);
    return () => { observer.disconnect(); media.removeEventListener("change", change); };
  }, []);
  useEffect(() => {
    if (active && owner === null) characterSlot.acquire(slotId.current);
    if (!active) characterSlot.release(slotId.current);
  }, [active, owner]);
  useEffect(() => () => characterSlot.release(slotId.current), []);
  useEffect(() => {
    if (!active || owner !== slotId.current) return;
    let disposed = false;
    setReady(false);
    void Promise.all([import("@paperclipai/shared/cliplab/runtime"), import("@paperclipai/shared/cliplab/definition")]).then(([runtime, library]) => {
      if (disposed || !host.current) return;
      player.current = runtime.createCharacter(host.current, library.characterDefinition(identity, muted), {
        animation: library.animationId(state), trackingRegion: trackingRegion?.current ?? root.current ?? undefined,
        followCursor, followRotation, trackingScope, displaySize: size, onError: () => setFailed(true),
      });
      setReady(true);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; player.current?.destroy(); player.current = null; setReady(false); };
  }, [active, owner, trackingRegion, trackingScope, size, followCursor, followRotation]);
  useEffect(() => {
    if (!player.current) return;
    void import("@paperclipai/shared/cliplab/definition").then(library => {
      player.current?.setDefinition(library.characterDefinition(identity, muted));
      player.current?.setAnimation(library.animationId(state));
    });
  }, [identity, muted, state, ready]);
  return <span ref={root} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    className={cn("relative inline-block shrink-0", avatarSizeClasses[size], className)}>
    <AgentAvatar agent={agent} appearance={identity} size={size < 256 ? 256 : size} name={name} pose={state} muted={muted} className={cn("size-full", ready && "invisible")} />
    <span ref={host} className="absolute inset-0" />
  </span>;
}
