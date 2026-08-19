import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PrpEvent } from "../../../../src/protocol/replay-contract";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  type SessionSnapshot,
} from "../../../../src/reducer/session-reducer";
import * as client from "./client";
import type {
  GoalOperation,
  LiveConnectionStatus,
  LiveManifestSummary,
  LiveSessionState,
} from "./protocol";
import {
  buildTranscript,
  composerState,
  type ComposerState,
  type TranscriptEntry,
} from "./transcript-model";

const SESSION_STORAGE_KEY = "paperclip-runner.live-console.session";
const RECONNECT_DELAY_MS = 900;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface LiveEventCursor {
  cursor: number;
  seenSourceEventIds: Set<string>;
}

export function createLiveEventCursor(
  events: readonly PrpEvent[] = [],
  cursor = 0,
): LiveEventCursor {
  return {
    cursor,
    seenSourceEventIds: new Set(events.map((event) => event.sourceEventId)),
  };
}

export function acceptLiveEvent(cursor: LiveEventCursor, event: PrpEvent): boolean {
  if (cursor.seenSourceEventIds.has(event.sourceEventId)) return false;
  cursor.seenSourceEventIds.add(event.sourceEventId);
  cursor.cursor = Math.max(cursor.cursor, event.sourceSeq);
  return true;
}

export type SteeringChipStatus = "pending" | "acknowledged" | "rejected" | "failed";

export interface SteeringChip {
  id: string;
  text: string;
  expectedTurnId: string;
  status: SteeringChipStatus;
  detail: string | null;
}

function reduceEvents(
  state: LiveSessionState | null,
  events: readonly PrpEvent[],
): SessionSnapshot | null {
  if (state === null) return null;
  const seed = createSessionSnapshotFromMetadata({
    fixtureName: state.snapshot.fixtureName,
    identity: state.snapshot.identity,
    capabilities: state.snapshot.capabilities,
  });
  return events.reduce(applyPrpEvent, seed);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof client.LiveConsoleError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export interface LiveConsole {
  manifests: LiveManifestSummary[];
  selectedManifestId: string;
  selectManifest: (id: string) => void;
  state: LiveSessionState | null;
  events: PrpEvent[];
  snapshot: SessionSnapshot | null;
  transcript: TranscriptEntry[];
  connection: LiveConnectionStatus;
  reconnectAttempt: number;
  replayParity: boolean | null;
  composer: ComposerState;
  steeringChips: SteeringChip[];
  announcement: string;
  error: string | null;
  busy: boolean;
  selectedThreadId: string | null;
  selectThread: (threadId: string | null) => void;
  replay: {
    active: boolean;
    position: number;
    length: number;
    playing: boolean;
    enter: () => void;
    exit: () => void;
    setPosition: (position: number) => void;
    togglePlay: () => void;
    step: (delta: number) => void;
  };
  start: (input: { manifestId: string; message: string }) => Promise<void>;
  send: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  resolve: (
    requestId: string,
    turnId: string,
    resolution: Record<string, unknown>,
  ) => Promise<void>;
  goal: (operation: GoalOperation, body?: Record<string, unknown>) => Promise<void>;
  dropConnection: () => void;
  retryNow: () => void;
  reset: () => Promise<void>;
  dismissSteeringChip: (id: string) => void;
}

export function useLiveConsole(): LiveConsole {
  const [manifests, setManifests] = useState<LiveManifestSummary[]>([]);
  const [selectedManifestId, setSelectedManifestId] = useState("completion");
  const [state, setState] = useState<LiveSessionState | null>(null);
  const [events, setEvents] = useState<PrpEvent[]>([]);
  const [connection, setConnection] = useState<LiveConnectionStatus>("idle");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [steeringChips, setSteeringChips] = useState<SteeringChip[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [replayActive, setReplayActive] = useState(false);
  const [replayPosition, setReplayPosition] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);

  const streamRef = useRef<client.EventStreamHandle | null>(null);
  const eventCursorRef = useRef(createLiveEventCursor());
  const sessionIdRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const subscribe = useCallback(
    (sessionId: string, attempt = 0) => {
      closeStream();
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      setReconnectAttempt(attempt);
      streamRef.current = client.openEventStream(sessionId, eventCursorRef.current.cursor, {
        onOpen: () => {
          setConnection("connected");
          setReconnectAttempt(0);
          setAnnouncement("Connected");
        },
        onEvent: (event) => {
          if (!acceptLiveEvent(eventCursorRef.current, event)) return;
          setEvents((current) => [...current, event]);
        },
        onError: () => {
          closeStream();
          if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            setConnection("disconnected");
            setAnnouncement("Disconnected");
            return;
          }
          setConnection("reconnecting");
          setReconnectAttempt(attempt + 1);
          setAnnouncement(`Reconnecting, attempt ${attempt + 1}`);
          retryTimerRef.current = setTimeout(
            () => subscribe(sessionId, attempt + 1),
            RECONNECT_DELAY_MS,
          );
        },
      });
    },
    [closeStream],
  );

  const adopt = useCallback(
    (next: LiveSessionState) => {
      setState(next);
      setError(null);
    },
    [],
  );

  const attach = useCallback(
    async (sessionId: string, resume: boolean) => {
      const [next, history] = await Promise.all([
        client.readSession(sessionId),
        client.readEvents(sessionId, 0),
      ]);
      sessionIdRef.current = sessionId;
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
      adopt(next);
      setEvents(history.events);
      eventCursorRef.current = createLiveEventCursor(history.events, history.cursor);
      if (resume) setAnnouncement("Replayed the durable transcript");
      subscribe(sessionId, 0);
    },
    [adopt, subscribe],
  );

  useEffect(() => {
    let cancelled = false;
    void client
      .fetchManifests()
      .then((list) => {
        if (cancelled) return;
        setManifests(list);
        if (list[0] !== undefined) setSelectedManifestId((current) => current || list[0]!.id);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored !== null) {
      void attach(stored, true).catch(() => {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      });
    }
    return () => {
      cancelled = true;
    };
    // Runs once: session restoration is a mount concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  // Lineage, goal, pending requests, and the server cursor live in the public
  // state, so a stream that only carries events would leave them stale.
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null || events.length === 0) return undefined;
    const timer = setTimeout(() => {
      void client
        .readSession(sessionId)
        .then((next) => setState(next))
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(timer);
  }, [events.length]);

  const liveSnapshot = useMemo(() => reduceEvents(state, events), [state, events]);
  const visibleEvents = useMemo(
    () => (replayActive ? events.slice(0, replayPosition) : events),
    [events, replayActive, replayPosition],
  );
  const snapshot = useMemo(
    () => (replayActive ? reduceEvents(state, visibleEvents) : liveSnapshot),
    [replayActive, state, visibleEvents, liveSnapshot],
  );

  const replayParity = useMemo(() => {
    if (state === null || liveSnapshot === null) return null;
    if (state.cursor !== events.length) return null;
    return (
      JSON.stringify(liveSnapshot.timeline) === JSON.stringify(state.snapshot.timeline) &&
      liveSnapshot.integrity === state.snapshot.integrity
    );
  }, [state, liveSnapshot, events.length]);

  const transcript = useMemo(
    () => (snapshot === null ? [] : buildTranscript(snapshot, visibleEvents)),
    [snapshot, visibleEvents],
  );

  useEffect(() => {
    if (!replayPlaying) return undefined;
    if (replayPosition >= events.length) {
      setReplayPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setReplayPosition((current) => current + 1), 140);
    return () => clearTimeout(timer);
  }, [replayPlaying, replayPosition, events.length]);

  // Steering chips resolve against canonical acknowledgements only.
  useEffect(() => {
    setSteeringChips((chips) => {
      if (chips.every((chip) => chip.status !== "pending")) return chips;
      const acknowledged = events.filter(
        (event) =>
          event.eventType === "item.completed" &&
          (event.payload as { kind?: string }).kind === "steering_acknowledgement",
      );
      let index = 0;
      return chips.map((chip) => {
        if (chip.status !== "pending") return chip;
        const match = acknowledged[index];
        index += 1;
        return match === undefined
          ? chip
          : { ...chip, status: "acknowledged" as const, detail: null };
      });
    });
  }, [events]);

  // The reducer is authoritative for the active turn. Falling back to the
  // last public-state read would keep a finished turn alive in the composer.
  const activeTurnId = snapshot === null ? (state?.activeTurnId ?? null) : snapshot.activeTurnId;

  // A submitted turn that has not been accepted yet is a protocol fact, not a
  // local flag: it is what makes interrupt-before-start reachable.
  const awaitingTurnStart = useMemo(() => {
    let pending = false;
    for (const entry of snapshot?.timeline ?? []) {
      if (entry.eventType === "turn.submitted") pending = true;
      else if (entry.eventType.startsWith("turn.")) pending = false;
    }
    return pending;
  }, [snapshot]);

  const composer = composerState({
    connection,
    submitting: submitting || awaitingTurnStart,
    interrupting,
    activeTurnId,
    sessionState: snapshot?.sessionState ?? "not_started",
  });

  const guard = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    async (input: { manifestId: string; message: string }) => {
      await guard(async () => {
        closeStream();
        setEvents([]);
        eventCursorRef.current = createLiveEventCursor();
        setSteeringChips([]);
        setReplayActive(false);
        setReplayPosition(0);
        setSelectedThreadId(null);
        setSubmitting(true);
        const manifest = manifests.find((entry) => entry.id === input.manifestId);
        try {
          const created = await client.createSession({
            manifest: input.manifestId,
            objective: manifest?.objective ?? "Run the Live console demo.",
            message: input.message,
          });
          sessionIdRef.current = created.sessionId;
          window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.sessionId);
          adopt(created);
          setAnnouncement("Turn running");
          subscribe(created.sessionId, 0);
        } finally {
          setSubmitting(false);
        }
      });
    },
    [adopt, closeStream, guard, manifests, subscribe],
  );

  const refreshState = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    adopt(await client.readSession(sessionId));
  }, [adopt]);

  const send = useCallback(
    async (text: string) => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) {
        await start({ manifestId: selectedManifestId, message: text });
        return;
      }
      await guard(async () => {
        setSubmitting(true);
        try {
          adopt(await client.startTurn(sessionId, text));
          setAnnouncement("Turn running");
        } finally {
          setSubmitting(false);
        }
      });
    },
    [adopt, guard, selectedManifestId, start],
  );

  const steer = useCallback(
    async (text: string) => {
      const sessionId = sessionIdRef.current;
      const expectedTurnId = activeTurnId;
      if (sessionId === null || expectedTurnId === null) return;
      const chipId = `steer-${Date.now()}-${steeringChips.length}`;
      setSteeringChips((chips) => [
        ...chips,
        { id: chipId, text, expectedTurnId, status: "pending", detail: null },
      ]);
      try {
        adopt(await client.steerTurn(sessionId, expectedTurnId, text));
        setAnnouncement("Steering sent");
      } catch (cause) {
        const stale =
          cause instanceof client.LiveConsoleError &&
          (cause.code === "stale_turn" || cause.code === "already_terminal");
        setSteeringChips((chips) =>
          chips.map((chip) =>
            chip.id === chipId
              ? {
                  ...chip,
                  status: stale ? "rejected" : "failed",
                  detail: stale ? "turn already ended" : errorMessage(cause),
                }
              : chip,
          ),
        );
        setAnnouncement(stale ? "Steering rejected: turn already ended" : "Steering failed");
        await refreshState().catch(() => undefined);
      }
    },
    [activeTurnId, adopt, refreshState, steeringChips.length],
  );

  const interrupt = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    setInterrupting(true);
    setAnnouncement("Stopping");
    try {
      adopt(await client.interruptTurn(sessionId, activeTurnId));
      setAnnouncement("Turn stopped");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setInterrupting(false);
    }
  }, [activeTurnId, adopt]);

  const resolve = useCallback(
    async (requestId: string, turnId: string, resolution: Record<string, unknown>) => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      await guard(async () => {
        adopt(await client.resolveRequest(sessionId, requestId, turnId, resolution));
        setAnnouncement("Request resolved");
      });
    },
    [adopt, guard],
  );

  const goal = useCallback(
    async (operation: GoalOperation, body: Record<string, unknown> = {}) => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      await guard(async () => {
        adopt(await client.goalOperation(sessionId, operation, body));
        setAnnouncement(`Goal ${operation}`);
      });
    },
    [adopt, guard],
  );

  const dropConnection = useCallback(() => {
    closeStream();
    setConnection("disconnected");
    setAnnouncement("Connection lost");
  }, [closeStream]);

  const retryNow = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    void guard(async () => {
      const resumed = await client.reconnectSession(sessionId);
      adopt(resumed);
      const history = await client.readEvents(sessionId, 0);
      setEvents(history.events);
      eventCursorRef.current = createLiveEventCursor(history.events, history.cursor);
      subscribe(sessionId, 0);
      setAnnouncement("Resumed the same session");
    });
  }, [adopt, guard, subscribe]);

  const reset = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    closeStream();
    if (sessionId !== null) {
      try {
        await client.closeSession(sessionId);
      } catch (cause) {
        setConnection("disconnected");
        setError(errorMessage(cause));
        setAnnouncement("Demo reset failed");
        return;
      }
    }
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionIdRef.current = null;
    eventCursorRef.current = createLiveEventCursor();
    setState(null);
    setEvents([]);
    setSteeringChips([]);
    setConnection("idle");
    setReplayActive(false);
    setReplayPosition(0);
    setSelectedThreadId(null);
    setError(null);
    setAnnouncement("Demo state reset");
  }, [closeStream]);

  const replay = useMemo(
    () => ({
      active: replayActive,
      position: replayPosition,
      length: events.length,
      playing: replayPlaying,
      enter: () => {
        setReplayActive(true);
        setReplayPosition(0);
        setReplayPlaying(false);
      },
      exit: () => {
        setReplayActive(false);
        setReplayPlaying(false);
      },
      setPosition: (position: number) =>
        setReplayPosition(Math.min(Math.max(position, 0), events.length)),
      togglePlay: () => setReplayPlaying((current) => !current),
      step: (delta: number) =>
        setReplayPosition((current) =>
          Math.min(Math.max(current + delta, 0), events.length),
        ),
    }),
    [events.length, replayActive, replayPlaying, replayPosition],
  );

  return {
    manifests,
    selectedManifestId,
    selectManifest: setSelectedManifestId,
    state,
    events,
    snapshot,
    transcript,
    connection,
    reconnectAttempt,
    replayParity,
    composer,
    steeringChips,
    announcement,
    error,
    busy,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    replay,
    start,
    send,
    steer,
    interrupt,
    resolve,
    goal,
    dropConnection,
    retryNow,
    reset,
    dismissSteeringChip: (id: string) =>
      setSteeringChips((chips) => chips.filter((chip) => chip.id !== id)),
  };
}
