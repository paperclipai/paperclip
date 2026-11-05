// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnnouncement } from "./useAnnouncement";
import { announcementPreview } from "@/lib/announcement-preview";
import { announcementStoragePrefix } from "@/lib/announcement-dismissals";

const api = vi.hoisted(() => ({ current: vi.fn(), dismiss: vi.fn() }));
vi.mock("@/api/announcements", () => ({ announcementsApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("announcement lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let userId: string;
  let companyId: string;
  let enabled: boolean;
  let failure: ReturnType<typeof vi.fn<(savedLocally: boolean) => void>>;
  let observed: ReturnType<typeof useAnnouncement>;
  let sequence = 0;
  function Harness() {
    observed = useAnnouncement({ userId, companyId, enabled, onSaveFailure: failure });
    return <div>{observed.announcement?.id}</div>;
  }
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); };
  const event = async (name: string) => { await act(async () => window.dispatchEvent(new Event(name))); };
  const visibility = async (value: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.current.mockResolvedValue(announcementPreview);
    api.dismiss.mockResolvedValue(undefined);
    userId = `user-${++sequence}`;
    companyId = "company-one";
    enabled = true;
    failure = vi.fn();
    // The repository's generic storage stub lacks key()/length; this feature
    // enumerates per-announcement entries, so exercise the full browser API.
    const entries = new Map<string, string>();
    const storage = {
      get length() { return entries.size; },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, String(value)); },
      removeItem: (key: string) => { entries.delete(key); },
      clear: () => entries.clear(),
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("settles before showing and never polls during uninterrupted work", async () => {
    await render();
    expect(container.textContent).toBe("");
    await settle();
    expect(container.textContent).toBe(announcementPreview.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
    expect(api.current).toHaveBeenCalledTimes(1);
    companyId = "company-two";
    await render();
    expect(api.current).toHaveBeenCalledTimes(1);
  });
  it("keeps a visible card stable when page focus moves to browser chrome or another pane", async () => {
    await render(); await settle();
    const request = api.current.mock.calls[0][0] as AbortSignal;
    await event("blur");
    expect(container.textContent).toBe(announcementPreview.id);
    await event("focus");
    expect(container.textContent).toBe(announcementPreview.id);
    await settle();
    expect(api.current).toHaveBeenCalledTimes(1);
    expect(request.aborted).toBe(false);
  });
  it("does not restart the initial settling period when a visible page gains focus", async () => {
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await event("blur"); await event("focus");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toBe(announcementPreview.id);
    expect(api.current).toHaveBeenCalledTimes(1);
  });
  it("dismisses immediately and stays dismissed after a remount and copy edit", async () => {
    await render(); await settle();
    await act(async () => observed.dismiss(announcementPreview.id));
    expect(container.textContent).toBe("");
    expect(api.dismiss).toHaveBeenCalledWith(announcementPreview.id, companyId, expect.any(AbortSignal));
    await act(async () => root.unmount());
    root = createRoot(container);
    api.current.mockResolvedValue({ ...announcementPreview, title: "Corrected" });
    await render(); await settle();
    expect(container.textContent).toBe("");
    expect(api.dismiss).toHaveBeenCalledTimes(1);
  });
  it("refreshes on return, showing a new ID but honoring dismissal in another browser", async () => {
    await render(); await settle();
    api.current.mockResolvedValue(null);
    await visibility("hidden"); await visibility("visible"); await settle();
    expect(container.textContent).toBe("");
    api.current.mockResolvedValue({ ...announcementPreview, id: "new-id" });
    await visibility("hidden"); await visibility("visible"); await settle();
    expect(container.textContent).toBe("new-id");
  });
  it("withholds a returning tab until its fresh dismissal check completes", async () => {
    await render(); await settle();
    await visibility("hidden");
    expect(container.textContent).toBe("");
    let resolve!: (value: null) => void;
    api.current.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await visibility("visible");
    // Browsers may report focus as well; it must not abort or duplicate the check.
    await event("focus"); await settle();
    expect(api.current).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
    await act(async () => resolve(null));
    expect(container.textContent).toBe("");
  });
  it("ignores a late response from before the tab was hidden", async () => {
    let resolve!: (value: typeof announcementPreview) => void;
    api.current.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render();
    const request = api.current.mock.calls[0][0] as AbortSignal;
    await visibility("hidden");
    expect(request.aborted).toBe(true);
    await act(async () => resolve(announcementPreview)); await settle();
    expect(container.textContent).toBe("");
    api.current.mockResolvedValue({ ...announcementPreview, id: "after-return" });
    await visibility("visible");
    expect(container.textContent).toBe("");
    await settle();
    expect(container.textContent).toBe("after-return");
  });
  it("keeps failed writes pending and retries on reconnect", async () => {
    api.dismiss.mockRejectedValueOnce(new Error("offline"));
    await render(); await settle();
    await act(async () => observed.dismiss(announcementPreview.id));
    expect(container.textContent).toBe("");
    expect(failure).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(`${announcementStoragePrefix(userId)}${announcementPreview.id}`)).toBe("pending");
    await event("online");
    expect(localStorage.getItem(`${announcementStoragePrefix(userId)}${announcementPreview.id}`)).toBe("synced");
  });
  it("does not leak a late fetch across an account change", async () => {
    let resolve!: (value: typeof announcementPreview) => void;
    api.current.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render(); await settle();
    userId = "different-account";
    api.current.mockResolvedValue(null);
    await render();
    await act(async () => resolve(announcementPreview));
    await settle();
    expect(container.textContent).toBe("");
  });
  it("closes after another tab writes a dismissal", async () => {
    await render(); await settle();
    const key = `${announcementStoragePrefix(userId)}${announcementPreview.id}`;
    localStorage.setItem(key, "synced");
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "synced" })));
    expect(container.textContent).toBe("");
  });
  it("honors a broadcast even when browser storage is unavailable", async () => {
    let channel!: { onmessage: ((event: MessageEvent) => void) | null };
    vi.stubGlobal("BroadcastChannel", class {
      onmessage = null;
      constructor() { channel = this; }
      postMessage() {}
      close() {}
    });
    await render(); await settle();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    await act(async () => channel.onmessage?.(new MessageEvent("message", { data: announcementPreview.id })));
    expect(container.textContent).toBe("");
    await visibility("hidden"); await visibility("visible"); await settle();
    expect(container.textContent).toBe("");
    expect(api.dismiss).toHaveBeenCalled();
  });
  it("withholds unknown state, disabled/onboarding state and hidden tabs", async () => {
    api.current.mockRejectedValue(new Error("unavailable"));
    await render(); await settle();
    expect(container.textContent).toBe("");
    enabled = false; await render();
    api.current.mockClear();
    await event("focus"); await settle();
    expect(api.current).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    enabled = true; await render(); await settle();
    expect(api.current).not.toHaveBeenCalled();
  });
  it("expires while visible", async () => {
    api.current.mockResolvedValue({ ...announcementPreview, expiresAt: new Date(Date.now() + 4000).toISOString() });
    await render(); await settle();
    expect(container.textContent).toBe(announcementPreview.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toBe("");
  });
});
