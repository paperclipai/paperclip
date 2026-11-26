import { useEffect, useRef, useState } from "react";
import { resolveAgentAppearance, type AgentAppearance } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import type { createCharacter } from "@paperclipai/shared/cliplab/runtime";
import type { Definition } from "@paperclipai/shared/cliplab/model";
import { colorOnboardingDefinition, resolveOnboardingSequences, sequenceDuration, sequenceLeadIn, type OnboardingSequences } from "./onboarding-character";

type Player = ReturnType<typeof createCharacter>;
type Phase = "asleep" | "awake";

export interface OnboardingCharacterProps {
  appearance: AgentAppearance;
  /** Review is the first step where an agent exists; that is where it wakes. */
  awake: boolean;
  className?: string;
}

/**
 * The onboarding hero: gray and dozing while the agent is being specified,
 * then — once on Review — it plays the studio's sleepy → wink → idle
 * transition while its palette fades in over the gray, and settles into the
 * idle loop.
 *
 * Played by the shared ClipLab engine directly rather than through
 * `AgentCharacter`: the arc needs a one-shot that the runtime reports as
 * complete (it then continues into the idle loop itself), a page-scoped
 * pointer, and two canvases for the colouring-in below. The character is the
 * same export every avatar renders, so what wakes here is what the agent
 * looks like everywhere after.
 *
 * Colouring in: the runtime's `setDefinition` restarts playback, so the body
 * cannot be recoloured mid-sequence. Instead a second canvas in the agent's
 * palette plays the same transition in lock-step above the gray one and fades
 * in; the gray canvas is destroyed once it is covered.
 *
 * Mounting straight onto Review (a reload, or a return to the wizard) shows
 * the awake hero without replaying the wake. Reduced motion skips the
 * sequence entirely: the runtime holds the first pose under that setting, so
 * the hero switches straight to its coloured idle.
 */
export function OnboardingCharacter({ appearance, awake, className }: OnboardingCharacterProps) {
  const identity = resolveAgentAppearance(appearance);
  const base = useRef<HTMLSpanElement>(null), overlay = useRef<HTMLSpanElement>(null);
  const players = useRef<{ base: Player | null; overlay: Player | null }>({ base: null, overlay: null });
  const library = useRef<{ create: typeof createCharacter; definition: Definition; sequences: OnboardingSequences } | null>(null);
  // What the live canvas currently shows, so a prop change is a transition
  // from something rather than a re-mount. Starts where the props say.
  const phase = useRef<Phase>(awake ? "awake" : "asleep");
  const renderedPalette = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [colored, setColored] = useState(awake);
  const [wakeSeconds, setWakeSeconds] = useState(0);

  const clearTimers = () => { for (const id of timers.current) window.clearTimeout(id); timers.current = []; };
  const destroy = (key: "base" | "overlay") => { players.current[key]?.destroy(); players.current[key] = null; };
  // A renderer failure (render, resize, context loss) hands the hero to the
  // still portrait — and releases both canvases, observers and contexts, which
  // otherwise stay allocated behind the fallback until the wizard unmounts.
  const fail = () => { clearTimers(); destroy("overlay"); destroy("base"); setReady(false); setFailed(true); };
  // Note: after a wake the live player sits in the overlay span; `mount` clears both spans.
  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Body-following, page-scoped: the engine turns the body toward the
  // pointer only while eye-following is off. Framing is the engine's
  // character framing, the same as every live AgentCharacter.
  const FOLLOW = { followCursor: false, followRotation: true, trackingScope: "page" as const, displaySize: 160 };

  /**
   * A fresh canvas (or pair) in the given phase; no transition. The loops
   * turn the body toward the pointer — body only, the eyes stay as authored
   * (the runtime only turns the body when eye-following is off).
   *
   * Asleep also mounts the coloured twin at opacity 0, playing the same loop
   * with the same options. The runtime fixes follow options and pointer state
   * at creation, so a twin created later would face front while the gray
   * canvas had already turned — a visible ghost through the crossfade. Created
   * together, both hear the same pointer events and stay in lock-step.
   * Each loop starts past its wrap-around ease so it opens on its own first beat.
   */
  function mount(next: Phase) {
    const lib = library.current;
    if (!lib || !base.current || !overlay.current) return;
    clearTimers(); destroy("overlay"); destroy("base");
    const animation = next === "asleep" ? lib.sequences.asleep : lib.sequences.awake;
    const leadIn = sequenceLeadIn(lib.definition, animation);
    const player = lib.create(base.current, colorOnboardingDefinition(lib.definition, identity, next === "asleep"), { animation, ...FOLLOW, onError: fail });
    players.current.base = player;
    player.seek(leadIn);
    if (players.current.base !== player) return;
    if (next === "asleep") {
      const twin = lib.create(overlay.current, colorOnboardingDefinition(lib.definition, identity, false), { animation, ...FOLLOW, onError: fail });
      players.current.overlay = twin;
      twin.seek(leadIn);
      if (players.current.overlay !== twin) return;
    }
    phase.current = next; renderedPalette.current = identity.paletteId; setColored(next === "awake");
  }

  /** The arc's payoff: both canvases play the transition together while the palette fades in. */
  function wake() {
    const lib = library.current, gray = players.current.base, twin = players.current.overlay;
    if (!lib || !gray || !twin || reducedMotion()) { mount("awake"); return; }
    clearTimers();
    // Skip the sequence's wrap-around ease so it opens asleep, not on a
    // blend of its own idle end; see sequenceLeadIn.
    const leadIn = sequenceLeadIn(lib.definition, lib.sequences.wake);
    const seconds = Math.max(0, sequenceDuration(lib.definition, lib.sequences.wake) - leadIn);
    setWakeSeconds(seconds);
    // Same tick, same offset: the two canvases stay in lock-step for the fade.
    for (const player of [gray, twin]) {
      player.setAnimation(lib.sequences.wake);
      if (players.current.base !== gray) return;
      player.seek(leadIn);
      if (players.current.base !== gray) return;
      player.play();
    }
    phase.current = "awake";
    // Next frame, so the fade transitions from the twin's opacity 0.
    timers.current.push(window.setTimeout(() => setColored(true), 0));
    // The engine continues a finished one-shot into the idle loop by itself.
    // The gray canvas is fully covered by then; the twin becomes the live
    // canvas as it is — same pointer state, no re-creation, so no snap — and
    // the idle loop starts past its wrap-around ease.
    timers.current.push(window.setTimeout(() => {
      destroy("base");
      players.current.base = players.current.overlay; players.current.overlay = null;
      players.current.base?.setAnimation(lib.sequences.awake);
      players.current.base?.seek(sequenceLeadIn(lib.definition, lib.sequences.awake));
    }, Math.ceil(seconds * 1000) + 50));
  }

  useEffect(() => {
    // The runtime observes its container and needs a GL canvas; where neither
    // exists (jsdom, some embedded views) the still portrait is the whole hero.
    if (typeof IntersectionObserver !== "function" || typeof ResizeObserver !== "function" || typeof WebGLRenderingContext === "undefined") { setFailed(true); return; }
    let disposed = false;
    setReady(false);
    void Promise.all([import("@paperclipai/shared/cliplab/runtime"), import("@paperclipai/shared/cliplab/character")]).then(([runtime, exported]) => {
      if (disposed) return;
      const definition = exported.PAPERCLIP_CHARACTER;
      library.current = { create: runtime.createCharacter, definition, sequences: resolveOnboardingSequences(definition) };
      mount(phase.current);
      if (players.current.base) setReady(true);
    }).catch((error: unknown) => {
      if (disposed) return;
      console.warn("Onboarding character unavailable, showing the still portrait.", error);
      fail();
    });
    return () => { disposed = true; clearTimers(); destroy("overlay"); destroy("base"); library.current = null; setReady(false); };
    // Mount once; later prop changes are transitions handled below.
  }, []);

  // Refresh the hidden colored twin too, before a simultaneous wake. The gray
  // canvas does not change color, but its twin must carry the new assignment.
  useEffect(() => {
    if (!ready || !library.current || renderedPalette.current === identity.paletteId) return;
    try { mount(phase.current); } catch (error) {
      console.warn("Onboarding character palette change failed, showing the still portrait.", error);
      fail();
    }
  }, [identity.paletteId, ready]);

  useEffect(() => {
    if (!ready || !library.current || !players.current.base) return;
    const next: Phase = awake ? "awake" : "asleep";
    if (next === phase.current) return;
    try {
      if (next === "awake") wake(); else mount("asleep");
    } catch (error) {
      console.warn("Onboarding character transition failed, showing the still portrait.", error);
      fail();
    }
  }, [awake, ready]);

  const live = ready && !failed;
  return (
    <span className={cn("relative inline-block", className)} aria-hidden="true">
      <AgentAvatar appearance={identity} size={256} pose={awake ? "rest" : "sleepy"} muted={!awake} className={cn("size-full", live && "invisible")} />
      <span ref={base} className="absolute inset-0" />
      <span
        ref={overlay}
        // Linear, over the whole sequence: the colour keeps arriving through
        // the wink and lands exactly as the face settles into its idle smile.
        className="absolute inset-0 transition-opacity ease-linear motion-reduce:transition-none"
        style={{ opacity: colored ? 1 : 0, transitionDuration: `${Math.max(0, wakeSeconds)}s` }}
      />
    </span>
  );
}
