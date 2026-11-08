import * as React from "react";

import { Composer, Dialog, Button } from "@paperclipai/paperclip-runner/react";
import {
  CapabilityChatSession,
  type CapabilityChatSessionArtifact,
  type CapabilityChatSessionOptions,
  type CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import { ChatConversation } from "./chat-conversation.js";
import { SessionHeader, type CapabilityChatMode } from "./chat-session-header.js";
import { EmptyState } from "./primitives.js";

/**
 * Scenario chat chat surface.
 *
 * Owns one live session client and nothing else: no protocol state, no policy
 * decision, no credential. Prompts go to the package-local mock control plane,
 * and the records that come back are rendered as they arrived.
 *
 * Session identity is deliberately explicit. `activeEntry` is the scenario the
 * open session belongs to, which is not always the scenario the route names:
 * switching discards mutable mock state, so it asks first, and until the board
 * answers, the header keeps naming the session that is actually running.
 */

export type CapabilityChatState = "seeding" | "pending" | "streaming" | "settled" | "failed";

export interface CapabilityChatSessionClient {
  artifact(): CapabilityChatSessionArtifact;
  nextPrompt(): string | null;
  send(prompt: string): Promise<CapabilityChatSessionArtifact>;
  replay(): Promise<CapabilityChatSessionArtifact>;
  close(): Promise<void>;
}

export type OpenCapabilityChatSession = (
  entry: CapabilityScenarioIndexEntry,
  options?: CapabilityChatSessionOptions,
) => Promise<CapabilityChatSessionClient>;

const openLocalSession: OpenCapabilityChatSession = (entry, options) =>
  CapabilityChatSession.open(entry, options);

export interface ChatSurfaceProps {
  entry: CapabilityScenarioIndexEntry;
  /** `replay=fake` plays the whole script on load for screenshot routes. */
  autoReplay: boolean;
  /** Holds the last scripted turn mid-stream for the streaming capture. */
  stageStreaming: boolean;
  codexAvailable?: boolean;
  activeTurn: number | null;
  onOpenTurn: (turn: number) => void;
  onOpenParity: () => void;
  onArtifactChange: (artifact: CapabilityChatSessionArtifact | null) => void;
  /** Mirrors the transcript reveal boundary to the activity stream. */
  onRevealSequenceChange: (sequence: number) => void;
  /**
   * Mirrors the settle state to the shell. The chat column is hidden on the
   * mobile Activity segment, so a wait target that only lives here would be
   * unreachable exactly where the evidence is.
   */
  onStateChange: (state: CapabilityChatState) => void;
  /** Called when the board declines a scenario switch, to restore the route. */
  onCancelScenarioSwitch: (entryId: string) => void;
  openSession?: OpenCapabilityChatSession;
  headerRef?: React.Ref<HTMLElement>;
}

export function ChatSurface({
  entry,
  autoReplay,
  stageStreaming,
  codexAvailable = false,
  activeTurn,
  onOpenTurn,
  onOpenParity,
  onArtifactChange,
  onRevealSequenceChange,
  onStateChange,
  onCancelScenarioSwitch,
  openSession = openLocalSession,
  headerRef,
}: ChatSurfaceProps) {
  const [artifact, setArtifact] = React.useState<CapabilityChatSessionArtifact | null>(null);
  const [activeEntry, setActiveEntry] = React.useState(entry);
  const [epoch, setEpoch] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [revealed, setRevealed] = React.useState(0);
  const [mode, setMode] = React.useState<CapabilityChatMode>("scripted");
  const [confirm, setConfirm] = React.useState<"none" | "reset" | "switch">("none");
  const sessionRef = React.useRef<CapabilityChatSessionClient | null>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);

  const switching = entry.id !== activeEntry.id;
  // A deep link plays its script once. An explicit reset means "back to the
  // seed", so it must not be immediately undone by the route replaying again.
  const shouldAutoReplay = autoReplay && epoch === 0;
  const instant = shouldAutoReplay && !stageStreaming;

  const publish = React.useCallback(
    (next: CapabilityChatSessionArtifact | null) => {
      setArtifact(next);
      onArtifactChange(next);
    },
    [onArtifactChange],
  );

  // One session per (scenario, epoch). Reset bumps the epoch, which is what
  // makes "reset" mean a genuinely new mock core rather than a cleared view.
  React.useEffect(() => {
    let live = true;
    setArtifact(null);
    setRevealed(0);
    setBusy(true);
    const opening = openSession(activeEntry, {});
    void opening.then(
      async (session) => {
        if (!live) {
          await session.close();
          return;
        }
        sessionRef.current = session;
        publish(session.artifact());
        if (shouldAutoReplay) {
          const played = await session.replay();
          if (!live) return;
          publish(played);
        }
        if (live) setBusy(false);
      },
      () => {
        if (live) setBusy(false);
      },
    );
    return () => {
      live = false;
      void opening.then((session) => session.close()).catch(() => undefined);
      sessionRef.current = null;
    };
  }, [activeEntry, epoch, openSession, publish, shouldAutoReplay]);

  const target = artifact?.timeline.at(-1)?.sequence ?? 0;
  const lastTurn = artifact?.turns.at(-1) ?? null;
  const heldModelSequence =
    lastTurn === null
      ? undefined
      : artifact?.timeline.find(
          (entry) => entry.turn === lastTurn.turn && entry.kind === "agent_message",
        )?.sequence;
  const holdAt =
    lastTurn === null
      ? 0
      : Math.max(
          Math.min(heldModelSequence ?? lastTurn.firstSequence, lastTurn.lastSequence - 1),
          lastTurn.firstSequence,
        );
  const ceiling = stageStreaming && lastTurn !== null && lastTurn.turn > 0 ? holdAt : target;

  // Streaming reveal. Replay routes and reduced-motion readers get the settled
  // transcript immediately; nothing about the record changes either way.
  React.useEffect(() => {
    if (instant || prefersReducedMotion()) {
      setRevealed(ceiling);
      return undefined;
    }
    if (revealed >= ceiling) return undefined;
    const timer = window.setTimeout(() => setRevealed((current) => Math.min(current + 1, ceiling)), 45);
    return () => window.clearTimeout(timer);
  }, [ceiling, instant, revealed]);

  const streaming = revealed < target;
  // "streaming" is a state the reveal has *arrived* at, not one it passes
  // through: a staged capture needs a stable wait target, and mid-reveal is
  // still pending.
  const chatState: CapabilityChatState =
    artifact === null
      ? "seeding"
      : artifact.status === "failed"
        ? "failed"
        : busy || revealed < ceiling
          ? "pending"
          : ceiling < target
            ? "streaming"
            : "settled";

  React.useEffect(() => {
    onStateChange(chatState);
  }, [chatState, onStateChange]);

  React.useEffect(() => {
    onRevealSequenceChange(revealed);
  }, [onRevealSequenceChange, revealed]);

  const send = React.useCallback(
    async (prompt: string) => {
      const session = sessionRef.current;
      if (session === null || prompt.trim().length === 0) return;
      setBusy(true);
      setDraft("");
      try {
        publish(await session.send(prompt.trim()));
      } finally {
        setBusy(false);
      }
    },
    [publish],
  );

  const replay = React.useCallback(async () => {
    const session = sessionRef.current;
    if (session === null) return;
    setBusy(true);
    try {
      publish(await session.replay());
    } finally {
      setBusy(false);
    }
  }, [publish]);

  const focusComposer = (): void => {
    composerRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  };

  // A scenario switch is a state discard, so it asks before it happens rather
  // than after (Forgiveness). A session with no turns has nothing to lose.
  React.useEffect(() => {
    if (!switching) return;
    if ((artifact?.turns.length ?? 0) > 1) setConfirm("switch");
    else setActiveEntry(entry);
  }, [artifact, entry, switching]);

  const suggestion = sessionRef.current?.nextPrompt() ?? null;
  const busyReason = busy
    ? "A turn is running."
    : artifact === null
      ? "The session is still seeding."
      : null;

  return (
    <div className="pcr7-chat" data-testid="chat-shell" data-chat-state={chatState}>
      <SessionHeader
        entry={activeEntry}
        artifact={artifact}
        mode={mode}
        codexAvailable={codexAvailable}
        busy={busy || revealed < target}
        onModeChange={setMode}
        onReset={() => setConfirm("reset")}
        onReplay={() => void replay()}
        onOpenParity={onOpenParity}
        headerRef={headerRef}
      />

      <p className="pcr7-visually-hidden" role="status" aria-live="polite" data-testid="chat-live-region">
        {chatState === "settled" && lastTurn !== null && lastTurn.turn > 0
          ? `Turn ${lastTurn.turn} settled — ${lastTurn.counts.denied} denied operation${
              lastTurn.counts.denied === 1 ? "" : "s"
            }, parity ${lastTurn.parity.verdict.replace("_", " ")}`
          : ""}
      </p>

      <div className="pcr7-chat-scroll">
        {artifact === null ? (
          <EmptyState title="Seeding the session…">
            <p className="pcr7-muted">
              The control plane is checking out the task and deciding tool exposure. Nothing has been
              asked of the agent yet.
            </p>
          </EmptyState>
        ) : (
          <ChatConversation
            artifact={artifact}
            revealedSequence={revealed}
            runningTurn={busy || streaming ? (lastTurn?.turn ?? null) : null}
            activeTurn={activeTurn}
            onOpenTurn={onOpenTurn}
          />
        )}
      </div>

      <div ref={composerRef} className="pcr7-chat-composer" data-testid="composer">
        {suggestion === null ? null : (
          <button
            type="button"
            className="pcr7-chip"
            data-testid="chat-suggested-prompt"
            disabled={busy}
            onClick={() => setDraft(suggestion)}
          >
            Suggested: {suggestion}
          </button>
        )}
        <Composer
          state={busy || streaming ? "active-turn" : "idle"}
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => void send(draft)}
          onStop={() => undefined}
          disabledReason={busyReason}
          label="Message the agent"
        />
        <p className="pcr7-muted" data-testid="composer-scope-note">
          {mode === "scripted"
            ? `Scripted mode — your prompt drives the next recorded turn against the isolated mock control plane. ${
                artifact?.remainingScriptedTurns ?? 0
              } scripted turn${(artifact?.remainingScriptedTurns ?? 0) === 1 ? "" : "s"} left.`
            : "Codex mode drives the same mock control plane through the server-side relay; no provider credential reaches this page."}
        </p>
        <p className="pcr7-muted">
          Synthetic demo only. Session state is memory-only and is cleared on reset, expiry, or restart;
          do not enter confidential or regulated data.
        </p>
      </div>

      <Dialog
        open={confirm !== "none"}
        onClose={() => setConfirm("none")}
        title={confirm === "switch" ? "Switch scenario?" : "Reset this session?"}
        description={
          confirm === "switch"
            ? "The mock core is seeded per scenario, so switching discards this transcript and its mock state."
            : "The transcript and mock state return to the seeded scenario."
        }
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              data-testid="confirm-cancel"
              onClick={() => {
                if (confirm === "switch") onCancelScenarioSwitch(activeEntry.id);
                setConfirm("none");
                focusComposer();
              }}
            >
              Keep this session
            </Button>
            <Button
              type="button"
              data-testid="confirm-accept"
              onClick={() => {
                if (confirm === "switch") setActiveEntry(entry);
                else setEpoch((current) => current + 1);
                setConfirm("none");
                focusComposer();
              }}
            >
              {confirm === "switch" ? "Switch scenario" : "Reset session"}
            </Button>
          </>
        }
      />
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
