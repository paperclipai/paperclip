import { useSyncExternalStore } from "react";

export interface ActivityLoadingSnapshot {
  activeRequests: number;
  activeNavigations: number;
  isLoading: boolean;
  lastInteractionAt: number;
}

type Listener = () => void;

const CLICK_INTERACTION_WINDOW_MS = 1_500;
const BUTTON_CAPTURE_WINDOW_MS = 350;
const CLICK_FLASH_DURATION_MS = 220;
const MIN_BUSY_VISIBLE_MS = 200;
const BUSY_SAFETY_TIMEOUT_MS = 30_000;

const SILENT_PATH_PATTERNS = [
  /\/api\/health(?:$|[/?])/,
  /\/events(?:$|[/?])/,
  /\/stream(?:$|[/?])/,
  /\/live-runs(?:$|[/?])/,
  /\/active-run(?:$|[/?])/,
  /\/attention(?:\/summary|\/history)?(?:$|[/?])/,
  /\/inbox-lite(?:$|[/?])/,
  /\/telemetry(?:$|[/?])/,
  /\/metrics(?:$|[/?])/,
  /\/logs(?:$|[/?])/,
  /\.(?:png|jpe?g|gif|svg|ico|webp|woff2?|css)(?:$|[?#])/i,
];

let activeRequests = 0;
let activeNavigations = 0;
let lastInteractionAt = 0;
let navigationWindowUntil = 0;
let lastClickedElement: Element | null = null;
let lastClickedAt = 0;
let snapshot: ActivityLoadingSnapshot = {
  activeRequests: 0,
  activeNavigations: 0,
  isLoading: false,
  lastInteractionAt: 0,
};

const listeners = new Set<Listener>();
const elementBusyState = new WeakMap<
  Element,
  { count: number; startedAt: number; clearTimer?: ReturnType<typeof setTimeout>; safetyTimer?: ReturnType<typeof setTimeout> }
>();
const clickFlashTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

let trackerCleanup: (() => void) | null = null;

function emit() {
  snapshot = {
    activeRequests,
    activeNavigations,
    isLoading: activeRequests > 0 || activeNavigations > 0,
    lastInteractionAt,
  };
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActivitySnapshot(): ActivityLoadingSnapshot {
  return snapshot;
}

export function useActivityLoading(): ActivityLoadingSnapshot {
  return useSyncExternalStore(subscribeActivity, getActivitySnapshot, getActivitySnapshot);
}

function findInteractiveTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('button, [role="button"], a[data-slot="button"]');
}

function flashClickedElement(element: Element) {
  const previousTimer = clickFlashTimers.get(element);
  if (previousTimer) clearTimeout(previousTimer);
  element.setAttribute("data-paperclip-clicked", "true");
  const timer = setTimeout(() => {
    clickFlashTimers.delete(element);
    if (element.getAttribute("data-paperclip-clicked") === "true") {
      element.removeAttribute("data-paperclip-clicked");
    }
  }, CLICK_FLASH_DURATION_MS);
  clickFlashTimers.set(element, timer);
}

function clearElementBusyNow(element: Element) {
  const entry = elementBusyState.get(element);
  if (entry?.clearTimer) clearTimeout(entry.clearTimer);
  if (entry?.safetyTimer) clearTimeout(entry.safetyTimer);
  elementBusyState.delete(element);
  element.removeAttribute("data-paperclip-busy");
}

function acquireElementBusy(element: Element): () => void {
  const now = Date.now();
  const existing = elementBusyState.get(element);
  if (existing?.clearTimer) {
    clearTimeout(existing.clearTimer);
    existing.clearTimer = undefined;
  }
  const entry = existing ?? { count: 0, startedAt: now };
  entry.count += 1;
  if (!existing) {
    entry.startedAt = now;
    elementBusyState.set(element, entry);
  }
  element.setAttribute("data-paperclip-busy", "true");
  if (entry.safetyTimer) clearTimeout(entry.safetyTimer);
  entry.safetyTimer = setTimeout(() => clearElementBusyNow(element), BUSY_SAFETY_TIMEOUT_MS);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = elementBusyState.get(element);
    if (!current) return;
    current.count = Math.max(0, current.count - 1);
    if (current.count > 0) return;
    if (!element.isConnected) {
      clearElementBusyNow(element);
      return;
    }
    const elapsed = Date.now() - current.startedAt;
    const delay = Math.max(0, MIN_BUSY_VISIBLE_MS - elapsed);
    if (delay === 0) {
      clearElementBusyNow(element);
    } else {
      current.clearTimer = setTimeout(() => clearElementBusyNow(element), delay);
    }
  };
}

function extractUrlAndMethod(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; headers?: Headers } {
  let url = "";
  let method = init?.method;
  let headers: Headers | undefined;
  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (input && typeof input === "object" && "url" in input) {
    url = input.url;
    if (!method && "method" in input) method = input.method;
    if ("headers" in input) headers = new Headers(input.headers);
  }
  if (init?.headers) {
    headers = new Headers(init.headers);
  }
  return { url, method: (method ?? "GET").toUpperCase(), headers };
}

function isSameOriginUrl(url: string, origin: string): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (!origin) return false;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

export function shouldTrackFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: { origin: string; now: number; lastInteractionAt: number; navigationWindowUntil: number },
): boolean {
  if (init?.keepalive) return false;
  const { url, method, headers } = extractUrlAndMethod(input, init);
  if (!isSameOriginUrl(url, options.origin)) return false;
  if (headers?.get("X-Paperclip-Background") === "true") return false;
  if (SILENT_PATH_PATTERNS.some((pattern) => pattern.test(url))) return false;

  if (method !== "GET" && method !== "HEAD") {
    return true;
  }

  return (
    options.now - options.lastInteractionAt <= CLICK_INTERACTION_WINDOW_MS
    || options.now <= options.navigationWindowUntil
  );
}

export function notifyRouteChange(windowMs = 1_200): void {
  const now = Date.now();
  navigationWindowUntil = Math.max(navigationWindowUntil, now + windowMs);
  lastInteractionAt = Math.max(lastInteractionAt, now);
}

export function beginRouteSuspense(): () => void {
  activeNavigations += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeNavigations = Math.max(0, activeNavigations - 1);
    emit();
  };
}

export function markInteractiveElementPending(element: Element | null): () => void {
  if (!element) return () => {};
  return acquireElementBusy(element);
}

export function recordUserInteraction(element: Element | null = null): void {
  const now = Date.now();
  lastInteractionAt = now;
  if (element) {
    lastClickedElement = element;
    lastClickedAt = now;
    flashClickedElement(element);
  }
}

export function startGlobalActivityTracker(target: Window = window): () => void {
  if (trackerCleanup) return trackerCleanup;

  const originalFetch = typeof target.fetch === "function" ? target.fetch : null;
  const origin = target.location?.origin ?? "";

  const onPointerOrClick = (event: Event) => {
    const interactive = findInteractiveTarget(event.target);
    const linkTarget = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (interactive) {
      recordUserInteraction(interactive);
    } else if (linkTarget) {
      recordUserInteraction(null);
      notifyRouteChange(1_200);
    }
  };

  const onSubmit = (event: Event) => {
    const submitEvent = event as SubmitEvent;
    const submitter = submitEvent.submitter instanceof Element ? submitEvent.submitter : null;
    const formButton = event.target instanceof HTMLFormElement
      ? event.target.querySelector('button[type="submit"], button:not([type])')
      : null;
    recordUserInteraction(submitter ?? formButton ?? lastClickedElement);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const interactive = findInteractiveTarget(event.target);
    if (interactive) {
      recordUserInteraction(interactive);
    } else if (event.key === "Enter" && event.target instanceof Element && event.target.closest("form")) {
      const form = event.target.closest("form")!;
      const submitBtn = form.querySelector('button[type="submit"], button:not([type])');
      recordUserInteraction(submitBtn);
    }
  };

  target.document?.addEventListener("pointerdown", onPointerOrClick, true);
  target.document?.addEventListener("click", onPointerOrClick, true);
  target.document?.addEventListener("submit", onSubmit, true);
  target.document?.addEventListener("keydown", onKeyDown, true);

  let wrappedFetch: typeof fetch | null = null;
  if (originalFetch) {
    wrappedFetch = function fetch(this: unknown, ...args: Parameters<typeof globalThis.fetch>) {
      const [input, init] = args;
      const now = Date.now();
      const tracked = shouldTrackFetchRequest(input, init, {
        origin,
        now,
        lastInteractionAt,
        navigationWindowUntil,
      });
      const response = originalFetch.apply(this ?? target, args);
      if (tracked && response && typeof response.then === "function") {
        activeRequests += 1;
        emit();
        const associatedButton =
          lastClickedElement
          && lastClickedElement.isConnected
          && now - lastClickedAt <= BUTTON_CAPTURE_WINDOW_MS
            ? lastClickedElement
            : null;
        const releaseButton = associatedButton ? acquireElementBusy(associatedButton) : null;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          activeRequests = Math.max(0, activeRequests - 1);
          emit();
          releaseButton?.();
        };
        response.then(finish, finish);
      }
      return response;
    } as typeof fetch;
    target.fetch = wrappedFetch;
  }

  trackerCleanup = () => {
    target.document?.removeEventListener("pointerdown", onPointerOrClick, true);
    target.document?.removeEventListener("click", onPointerOrClick, true);
    target.document?.removeEventListener("submit", onSubmit, true);
    target.document?.removeEventListener("keydown", onKeyDown, true);
    if (originalFetch && wrappedFetch && target.fetch === wrappedFetch) {
      target.fetch = originalFetch;
    }
    activeRequests = 0;
    activeNavigations = 0;
    lastClickedElement = null;
    emit();
    trackerCleanup = null;
  };

  return trackerCleanup;
}
