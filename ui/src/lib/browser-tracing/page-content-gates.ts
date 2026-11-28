// Readiness gates that tell the page-load recorder when a page has rendered.
//
// This module is in the main bundle and holds only a small map. It sends
// nothing anywhere; the recorder reads it only when browser tracing is active.
//
// Two kinds of gate exist:
// - `blocking`: a full-page loading state is on screen (for example the
//   `PaperclipLoading` spinner or a route Suspense fallback). The page is not
//   loaded while any blocking gate is mounted.
// - `content`: a page declared its own "primary content painted" signal with
//   `usePageContentReady`. When a page has one, that signal defines "loaded"
//   instead of the generic network-idle rule.

export type PageContentGateKind = "blocking" | "content";

interface GateState {
  kind: PageContentGateKind;
  /** `performance.now()` when the gate became ready, or null while pending. */
  readyAt: number | null;
}

const gates = new Map<number, GateState>();
let nextGateId = 1;

export function registerPageContentGate(kind: PageContentGateKind): number {
  const id = nextGateId++;
  gates.set(id, { kind, readyAt: null });
  return id;
}

export function setPageContentGateReady(id: number, readyAt: number | null): void {
  const gate = gates.get(id);
  if (gate && gate.kind === "content") gate.readyAt = readyAt;
}

export function unregisterPageContentGate(id: number): void {
  gates.delete(id);
}

export interface PageContentGateSnapshot {
  blockingCount: number;
  contentCount: number;
  pendingContentCount: number;
  /** Latest `readyAt` among content gates, or null when none are ready. */
  lastContentReadyAt: number | null;
}

export function readPageContentGates(): PageContentGateSnapshot {
  let blockingCount = 0;
  let contentCount = 0;
  let pendingContentCount = 0;
  let lastContentReadyAt: number | null = null;
  for (const gate of gates.values()) {
    if (gate.kind === "blocking") {
      blockingCount += 1;
      continue;
    }
    contentCount += 1;
    if (gate.readyAt === null) pendingContentCount += 1;
    else if (lastContentReadyAt === null || gate.readyAt > lastContentReadyAt) lastContentReadyAt = gate.readyAt;
  }
  return { blockingCount, contentCount, pendingContentCount, lastContentReadyAt };
}

/** Test helper. */
export function resetPageContentGatesForTest(): void {
  gates.clear();
  nextGateId = 1;
}
