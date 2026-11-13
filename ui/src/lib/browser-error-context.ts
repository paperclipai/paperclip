export interface BrowserErrorDetails {
  boundary: "app" | "route";
  componentStack?: string | null;
}

const MAX_STACK_LENGTH = 16_384;
const MAX_COMPONENT_FRAMES = 40;

/** Keep component names only: React stack locations can contain tenant URLs. */
export function sanitizeComponentStack(stack: string | null | undefined): string | undefined {
  if (!stack) return undefined;
  const frames: string[] = [];
  for (const line of stack.slice(0, MAX_STACK_LENGTH).split("\n").slice(0, MAX_COMPONENT_FRAMES + 1)) {
    // V8/React and Firefox/Safari component-frame formats. Never retain the
    // location, arguments, or an unrecognized line as a fallback.
    const name = /^\s*(?:at|in) ([A-Za-z_$][\w$.-]{0,99})(?:\s|$)/.exec(line)?.[1]
      ?? /^([A-Za-z_$][\w$.-]{0,99})@/.exec(line)?.[1];
    if (name) frames.push(`    at ${name}`);
    if (frames.length === MAX_COMPONENT_FRAMES) break;
  }
  return frames.length ? `\n${frames.join("\n")}` : undefined;
}

/** Bounded document state; never read page content, locations, or identifiers. */
export function readBrowserErrorState() {
  const browserState: {
    ready_state?: "loading" | "interactive" | "complete";
    visibility_state?: "visible" | "hidden";
    translation_marker?: boolean;
  } = {};
  if (typeof document !== "undefined") {
    // Each read is optional. A DOM wrapper or extension must not prevent the
    // original exception and component trace from reaching the error monitor.
    try {
      const state = document.readyState;
      if (state === "loading" || state === "interactive" || state === "complete") {
        browserState.ready_state = state;
      }
    } catch { /* diagnostic unavailable */ }
    try {
      const state = document.visibilityState;
      if (state === "visible" || state === "hidden") browserState.visibility_state = state;
    } catch { /* diagnostic unavailable */ }
    try {
      const classes = document.documentElement.classList;
      browserState.translation_marker = classes.contains("translated-ltr") || classes.contains("translated-rtl");
    } catch { /* diagnostic unavailable */ }
  }
  return browserState;
}

type PageTransition = "visible" | "hidden" | "pagehide" | "pageshow" | "freeze" | "resume";
type ElapsedBucket = "<1s" | "1-10s" | "10-60s" | "1-10m" | ">10m";
type RejectionPromiseKind = "native" | "subclass" | "other" | "missing";

interface RejectionEventSnapshot {
  at: number;
  /** Same classification as the `browser_rejection_kind` tag, used to pair the event. */
  kind: string;
  trusted: boolean;
  promise: RejectionPromiseKind;
}

/** A rejection report is paired with its DOM event only within this window. */
const REJECTION_PAIRING_WINDOW_MS = 5_000;

let lastTransition: { kind: PageTransition; at: number } | undefined;
let pagehideSeen = false;
let lastRejection: RejectionEventSnapshot | undefined;
let pageDiagnosticsStarted = false;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function bucketElapsed(ms: number): ElapsedBucket {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 600_000) return "1-10m";
  return ">10m";
}

/** Classify without reading the rejected value or calling into the promise. */
export function classifyRejectionReason(reason: unknown) {
  return reason === null ? "null" : typeof reason;
}

function classifyRejectionPromise(event: PromiseRejectionEvent): RejectionPromiseKind {
  try {
    const promise: unknown = event.promise;
    if (typeof promise !== "object" || promise === null) return "missing";
    if (Object.getPrototypeOf(promise) === Promise.prototype) return "native";
    return promise instanceof Promise ? "subclass" : "other";
  } catch {
    return "other";
  }
}

/**
 * Record page lifecycle transitions and the shape of each unhandled rejection
 * event. Only enum values and timestamps stay in memory; nothing is sent from
 * here. Idempotent, and kept for the page lifetime so a later sign-in still
 * registers before the error monitor's own rejection handler.
 */
export function startPageDiagnostics(target: Window = window, doc: Document = document): void {
  if (pageDiagnosticsStarted) return;
  pageDiagnosticsStarted = true;
  const mark = (kind: PageTransition) => {
    lastTransition = { kind, at: now() };
    if (kind === "pagehide") pagehideSeen = true;
    if (kind === "pageshow") pagehideSeen = false;
  };
  try {
    doc.addEventListener("visibilitychange", () => {
      try {
        mark(doc.visibilityState === "hidden" ? "hidden" : "visible");
      } catch { /* diagnostic unavailable */ }
    });
    doc.addEventListener("freeze", () => mark("freeze"));
    doc.addEventListener("resume", () => mark("resume"));
    target.addEventListener("pagehide", () => mark("pagehide"));
    target.addEventListener("pageshow", () => mark("pageshow"));
    // Capture phase, registered before the SDK assigns `onunhandledrejection`,
    // so this snapshot exists before the SDK builds and filters its event.
    target.addEventListener("unhandledrejection", (event) => {
      try {
        lastRejection = {
          at: now(),
          kind: classifyRejectionReason(event.reason),
          trusted: event.isTrusted,
          promise: classifyRejectionPromise(event),
        };
      } catch { /* diagnostic unavailable */ }
    }, { capture: true });
  } catch { /* diagnostic unavailable */ }
}

/** Coarse lifecycle timing; no page content, locations, or identifiers. */
export function readPageLifecycle() {
  const at = now();
  const lifecycle: {
    since_load: ElapsedBucket;
    pagehide_seen: boolean;
    last_transition?: PageTransition;
    since_transition?: ElapsedBucket;
  } = { since_load: bucketElapsed(at), pagehide_seen: pagehideSeen };
  if (lastTransition) {
    lifecycle.last_transition = lastTransition.kind;
    lifecycle.since_transition = bucketElapsed(at - lastTransition.at);
  }
  return lifecycle;
}

/** Consume the snapshot of the DOM event that produced this rejection report. */
export function takeRejectionEventSnapshot(kind: string) {
  const snapshot = lastRejection;
  lastRejection = undefined;
  if (!snapshot || snapshot.kind !== kind || now() - snapshot.at > REJECTION_PAIRING_WINDOW_MS) return undefined;
  return { trusted: snapshot.trusted, promise: snapshot.promise };
}

/** Test-only: forget recorded lifecycle state. Listeners stay attached. */
export function __resetPageDiagnostics() {
  lastTransition = undefined;
  pagehideSeen = false;
  lastRejection = undefined;
}

/** A bounded snapshot, taken at the error rather than when the capture queue runs. */
export function buildBrowserErrorContext(details: BrowserErrorDetails) {
  const componentStack = sanitizeComponentStack(details.componentStack);
  return {
    tags: { react_error_boundary: details.boundary },
    contexts: {
      react: componentStack ? { componentStack } : {},
      browser_state: readBrowserErrorState(),
      page_lifecycle: readPageLifecycle(),
    },
  };
}
