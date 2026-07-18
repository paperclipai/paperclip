export const SELECTION_DEBUG_STORAGE_KEY = "paperclipDebugSelection";

type SelectionDebugEvent = {
  at: number;
  type: string;
  details: Record<string, number | string | boolean>;
};

type SelectionDebugState = {
  enabledAt: number;
  selectionChanges: number;
  activeSelectionChanges: number;
  captureCount: number;
  captureDurationMs: number;
  maxCaptureDurationMs: number;
  mutationCallbacks: number;
  mutationRecords: number;
  idleMutationCallbacks: number;
  idleMutationRecords: number;
  reactCommits: Record<string, number>;
  events: SelectionDebugEvent[];
  lastSelectionChangeAt: number | null;
  reset: () => void;
  snapshot: () => Omit<SelectionDebugState, "reset" | "snapshot">;
};

declare global {
  interface Window {
    __paperclipSelectionDebug?: SelectionDebugState;
  }
}

const MAX_DEBUG_EVENTS = 250;
const IDLE_SELECTION_WINDOW_MS = 150;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function createState(): SelectionDebugState {
  const state: SelectionDebugState = {
    enabledAt: now(),
    selectionChanges: 0,
    activeSelectionChanges: 0,
    captureCount: 0,
    captureDurationMs: 0,
    maxCaptureDurationMs: 0,
    mutationCallbacks: 0,
    mutationRecords: 0,
    idleMutationCallbacks: 0,
    idleMutationRecords: 0,
    reactCommits: {},
    events: [],
    lastSelectionChangeAt: null,
    reset: () => {
      state.enabledAt = now();
      state.selectionChanges = 0;
      state.activeSelectionChanges = 0;
      state.captureCount = 0;
      state.captureDurationMs = 0;
      state.maxCaptureDurationMs = 0;
      state.mutationCallbacks = 0;
      state.mutationRecords = 0;
      state.idleMutationCallbacks = 0;
      state.idleMutationRecords = 0;
      state.reactCommits = {};
      state.events = [];
      state.lastSelectionChangeAt = null;
    },
    snapshot: () => ({
      enabledAt: state.enabledAt,
      selectionChanges: state.selectionChanges,
      activeSelectionChanges: state.activeSelectionChanges,
      captureCount: state.captureCount,
      captureDurationMs: state.captureDurationMs,
      maxCaptureDurationMs: state.maxCaptureDurationMs,
      mutationCallbacks: state.mutationCallbacks,
      mutationRecords: state.mutationRecords,
      idleMutationCallbacks: state.idleMutationCallbacks,
      idleMutationRecords: state.idleMutationRecords,
      reactCommits: { ...state.reactCommits },
      events: [...state.events],
      lastSelectionChangeAt: state.lastSelectionChangeAt,
    }),
  };
  return state;
}

export function isSelectionDebugEnabled(): boolean {
  if (import.meta.env.MODE === "production" || typeof window === "undefined") return false;
  try {
    const value = window.localStorage.getItem(SELECTION_DEBUG_STORAGE_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

export function initializeSelectionDebug(): SelectionDebugState {
  if (!window.__paperclipSelectionDebug) {
    window.__paperclipSelectionDebug = createState();
    console.info(`[paperclip selection debug] enabled; set localStorage.${SELECTION_DEBUG_STORAGE_KEY} = "0" and reload to disable`);
  }
  return window.__paperclipSelectionDebug;
}

function record(type: string, details: SelectionDebugEvent["details"]): void {
  const state = initializeSelectionDebug();
  const event = { at: now(), type, details };
  state.events.push(event);
  if (state.events.length > MAX_DEBUG_EVENTS) state.events.shift();
  console.debug("[paperclip selection debug]", event);
}

export function recordSelectionChange(active: boolean): void {
  const state = initializeSelectionDebug();
  const timestamp = now();
  const elapsedSincePreviousMs = state.lastSelectionChangeAt === null
    ? null
    : timestamp - state.lastSelectionChangeAt;
  state.selectionChanges += 1;
  if (active) {
    state.activeSelectionChanges += 1;
  }
  state.lastSelectionChangeAt = timestamp;
  record("selectionchange", {
    active,
    elapsedSincePreviousMs: elapsedSincePreviousMs ?? -1,
  });
}

export function recordCaptureSelection(durationMs: number, captured: boolean): void {
  const state = initializeSelectionDebug();
  state.captureCount += 1;
  state.captureDurationMs += durationMs;
  state.maxCaptureDurationMs = Math.max(state.maxCaptureDurationMs, durationMs);
  record("captureSelection", { durationMs, captured });
}

export function recordAnnotationCommit(id: string, phase: string, actualDuration: number): void {
  const state = initializeSelectionDebug();
  state.reactCommits[id] = (state.reactCommits[id] ?? 0) + 1;
  record("react-commit", { id, phase, actualDuration });
}

export function recordMarkdownMutations(recordCount: number): void {
  const state = initializeSelectionDebug();
  const idle = state.lastSelectionChangeAt !== null && now() - state.lastSelectionChangeAt >= IDLE_SELECTION_WINDOW_MS;
  state.mutationCallbacks += 1;
  state.mutationRecords += recordCount;
  if (idle) {
    state.idleMutationCallbacks += 1;
    state.idleMutationRecords += recordCount;
  }
  record("markdown-mutation", { recordCount, idle });
}
