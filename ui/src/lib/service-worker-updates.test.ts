import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServiceWorkerUpdates } from "./service-worker-updates";

type Listener = () => void;

function fakeContainer(opts: { controlled: boolean }) {
  const listeners = new Map<string, Set<Listener>>();
  const registration = { update: vi.fn(() => Promise.resolve()) };
  const container = {
    controller: opts.controlled ? ({} as ServiceWorker) : null,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    }),
  };
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { container: container as unknown as ServiceWorkerContainer, registration, emit, listeners };
}

function fakeDocument(initialVisibility: DocumentVisibilityState = "visible") {
  const listeners = new Map<string, Set<Listener>>();
  const doc = {
    visibilityState: initialVisibility,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { doc: doc as unknown as Document & { visibilityState: DocumentVisibilityState }, emit, listeners };
}

describe("startServiceWorkerUpdates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers /sw.js", async () => {
    const { container } = fakeContainer({ controlled: false });
    const { doc } = fakeDocument();
    startServiceWorkerUpdates({ container, documentRef: doc, reload: vi.fn() });
    expect(container.register).toHaveBeenCalledWith("/sw.js");
  });

  it("reloads once when a new worker takes over a hidden, already-controlled page", async () => {
    const { container, emit } = fakeContainer({ controlled: true });
    const { doc } = fakeDocument("hidden");
    const reload = vi.fn();
    startServiceWorkerUpdates({ container, documentRef: doc, reload });

    emit("controllerchange");
    emit("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("defers the reload to the next hidden transition when the takeover lands mid-session", async () => {
    const { container, emit } = fakeContainer({ controlled: true });
    const docState = fakeDocument("visible");
    const reload = vi.fn();
    startServiceWorkerUpdates({ container, documentRef: docState.doc, reload });

    emit("controllerchange");
    // The user is looking at the page: never yank it out from under them.
    expect(reload).not.toHaveBeenCalled();

    docState.doc.visibilityState = "hidden";
    docState.emit("visibilitychange");
    expect(reload).toHaveBeenCalledTimes(1);

    docState.emit("visibilitychange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on a first-ever install", async () => {
    const { container, emit } = fakeContainer({ controlled: false });
    const { doc } = fakeDocument("hidden");
    const reload = vi.fn();
    startServiceWorkerUpdates({ container, documentRef: doc, reload });

    emit("controllerchange");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when a later deploy replaces the worker a first-visit tab installed", async () => {
    const { container, emit } = fakeContainer({ controlled: false });
    const { doc } = fakeDocument("hidden");
    const reload = vi.fn();
    startServiceWorkerUpdates({ container, documentRef: doc, reload });

    // First takeover: the fresh install controls the page, no reload.
    emit("controllerchange");
    expect(reload).not.toHaveBeenCalled();

    // A deploy lands while the same tab is still open: now the controller
    // change means newer code, and the hidden tab reloads onto it.
    emit("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("checks for updates when the tab becomes visible", async () => {
    const { container, registration, emit } = fakeContainer({ controlled: true });
    const docState = fakeDocument("hidden");
    startServiceWorkerUpdates({ container, documentRef: docState.doc, reload: vi.fn() });
    await vi.waitFor(() => expect(container.register).toHaveBeenCalled());
    // Let the register() promise settle so the registration is captured.
    await Promise.resolve();

    docState.emit("visibilitychange");
    expect(registration.update).not.toHaveBeenCalled();

    docState.doc.visibilityState = "visible";
    docState.emit("visibilitychange");
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("checks for updates on the timer", async () => {
    const { container, registration } = fakeContainer({ controlled: true });
    const { doc } = fakeDocument();
    startServiceWorkerUpdates({
      container,
      documentRef: doc,
      reload: vi.fn(),
      updateIntervalMs: 1000,
    });
    await Promise.resolve();

    vi.advanceTimersByTime(3000);
    expect(registration.update).toHaveBeenCalledTimes(3);
  });

  it("stops listening and ticking after cleanup", async () => {
    const { container, registration, emit, listeners } = fakeContainer({ controlled: true });
    const docState = fakeDocument();
    const reload = vi.fn();
    const stop = startServiceWorkerUpdates({
      container,
      documentRef: docState.doc,
      reload,
      updateIntervalMs: 1000,
    });
    await Promise.resolve();

    stop();
    emit("controllerchange");
    docState.emit("visibilitychange");
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    expect(listeners.get("controllerchange")?.size ?? 0).toBe(0);
  });

  it("is a no-op without a service worker container", () => {
    expect(() => startServiceWorkerUpdates({ reload: vi.fn() })()).not.toThrow();
  });
});
