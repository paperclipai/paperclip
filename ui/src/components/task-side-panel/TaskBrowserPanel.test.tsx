// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { ApiError } from "@/api/client";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskBrowserPanel } from "./TaskBrowserPanel";
vi.mock("@/api/browser-use", () => ({ browserUseApi: {
  viewer: vi.fn(async () => ({ url: "https://live.browser-use.com/test", viewport: "default" })),
  presence: vi.fn(async () => ({ accepted: true })),
  control: vi.fn(), resize: vi.fn(), releaseViewport: vi.fn(async () => ({})),
} }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, cache: QueryClient;
let hidden = false, paneVisible = true;
const browser: TaskBrowser = { id: "browser", sessionId: "session", issueId: "task", status: "idle", runStatus: "completed", progress: null, error: null, costCents: 0, idleDeadline: null, expiresAt: null, createdAt: "2026-09-29T00:00:00Z" };
async function render(active = true) {
  await act(async () => root.render(<QueryClientProvider client={cache}><TooltipProvider><TaskBrowserPanel issueId="task" browser={browser} active={active} /></TooltipProvider></QueryClientProvider>));
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function viewerLoaded() { await act(async () => host.querySelector('iframe')!.dispatchEvent(new Event('load'))); }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hidden = false; paneVisible = true;
  vi.mocked(browserUseApi.presence).mockResolvedValue({ accepted: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as any);
  Object.defineProperty(Element.prototype, "checkVisibility", { configurable: true, value: () => paneVisible });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); delete (Element.prototype as any).checkVisibility; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("renews only while the selected viewer is visible, even with a fixed viewport", async () => {
  await render(); expect(browserUseApi.presence).toHaveBeenCalledTimes(1);
  await viewerLoaded();
  await tick(30_000); expect(browserUseApi.presence).toHaveBeenCalledTimes(2);
  await render(false); await tick(60_000); expect(browserUseApi.presence).toHaveBeenCalledTimes(2);
  await render(); expect(browserUseApi.presence).toHaveBeenCalledTimes(3);
  hidden = true; await tick(30_000); expect(browserUseApi.presence).toHaveBeenCalledTimes(3);
  hidden = false; paneVisible = false; await tick(30_000); expect(browserUseApi.presence).toHaveBeenCalledTimes(3);
  paneVisible = true; await tick(30_000); expect(browserUseApi.presence).toHaveBeenCalledTimes(4);
});
it("automatically reconnects a stalled iframe once, then shows an actionable timeout", async () => {
  await render(); expect(host.textContent).toContain("Connecting to browser");
  const initialFrame = host.querySelector('iframe');
  await tick(15_000);
  expect(host.querySelector('iframe')).not.toBe(initialFrame);
  expect(host.textContent).toContain("Connecting to browser");
  await tick(15_000); expect(host.textContent).toContain("The live view did not load");
  const failedFrame = host.querySelector('iframe');
  await tick(60_000); expect(host.querySelector('iframe')).toBe(failedFrame);
  expect(browserUseApi.resize).not.toHaveBeenCalled();
  const reconnect = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Reconnect view')!;
  await act(async () => reconnect.click());
  expect(host.textContent).toContain("Connecting to browser");
  await viewerLoaded();
  await tick(15_000); expect(host.textContent).not.toContain("The live view did not load");
});
it("does not use up the load window or reconnect while the browser tab is hidden", async () => {
  await render(false);
  const initialFrame = host.querySelector('iframe');
  await tick(60_000);
  expect(host.querySelector('iframe')).toBe(initialFrame);
  expect(host.textContent).not.toContain("The live view did not load");
  await render();
  await tick(14_000); expect(host.querySelector('iframe')).toBe(initialFrame);
  await tick(1_000); expect(host.querySelector('iframe')).not.toBe(initialFrame);
  await viewerLoaded();
  const loadedFrame = host.querySelector('iframe');
  await tick(60_000); expect(host.querySelector('iframe')).toBe(loadedFrame);
  expect(host.textContent).not.toContain("The live view did not load");
});
it("reports failed keep-open and clears the warning after recovery", async () => {
  vi.mocked(browserUseApi.presence).mockRejectedValueOnce(new Error("offline"));
  await render(); expect(host.textContent).toContain("Could not keep this browser open");
  await viewerLoaded();
  await tick(30_000); expect(host.textContent).not.toContain("Could not keep this browser open");
});

// --- Disconnect handling for the viewer credential read -------------------------

const unavailable = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });
let store: ConnectivityStore;
let probe: ReturnType<typeof vi.fn<() => Promise<{ reachable: boolean; retryAfterMs: number | null }>>>;
beforeEach(() => {
  probe = vi.fn(async () => ({ reachable: true, retryAfterMs: null }));
  store = createConnectivityStore({ probe: probe as never, browserOnline: true });
});
afterEach(() => { store.dispose(); });
async function renderResilient(active = true) {
  await act(async () => root.render(<ConnectivityProvider store={store}><QueryClientProvider client={cache}><TooltipProvider><TaskBrowserPanel issueId="task" browser={browser} active={active} /></TooltipProvider></QueryClientProvider></ConnectivityProvider>));
}
it("keeps the loaded live view through a transient viewer failure", async () => {
  await renderResilient();
  await viewerLoaded();
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://live.browser-use.com/test");
  vi.mocked(browserUseApi.viewer).mockRejectedValue(unavailable());
  await tick(15_000);
  // The revalidation failed with an outage-class error: the iframe stays, with no red copy.
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://live.browser-use.com/test");
  expect(host.textContent).not.toContain("The live view disconnected");
  expect(host.querySelector('[data-query-view="error"]')).toBeNull();
  await tick(60_000);
  expect(host.querySelector("iframe")).not.toBeNull();
  vi.mocked(browserUseApi.viewer).mockResolvedValue({ url: "https://live.browser-use.com/test", viewport: "default" });
  await tick(15_000);
  expect(host.querySelector('[data-query-view="stale"]')).toBeNull();
  expect(host.querySelector("iframe")).not.toBeNull();
});
it("removes the iframe when the viewer credential is revoked", async () => {
  await renderResilient();
  await viewerLoaded();
  expect(host.querySelector("iframe")).not.toBeNull();
  vi.mocked(browserUseApi.viewer).mockRejectedValue(new ApiError("You no longer have access to this browser.", 403, { error: "You no longer have access to this browser." }));
  await tick(15_000);
  expect(host.querySelector("iframe")).toBeNull();
  const alert = host.querySelector('[data-query-view="error"]');
  expect(alert?.textContent).toContain("Couldn't connect to the live browser view");
  expect(alert?.textContent).toContain("You no longer have access to this browser.");
  expect(alert?.querySelector("button")).toBeNull();
  // Revalidation keeps running, so restored access brings the view back by itself.
  vi.mocked(browserUseApi.viewer).mockResolvedValue({ url: "https://live.browser-use.com/restored", viewport: "default" });
  await tick(15_000);
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://live.browser-use.com/restored");
});
it("shows a quiet placeholder for a first load during an outage and recovers by itself", async () => {
  probe.mockResolvedValue({ reachable: false, retryAfterMs: null });
  vi.mocked(browserUseApi.viewer).mockRejectedValue(unavailable());
  await renderResilient();
  await act(async () => { store.reportError(unavailable()); });
  await tick(50);
  expect(store.getSnapshot().status).toBe("reconnecting");
  expect(host.querySelector("iframe")).toBeNull();
  expect(host.textContent).toContain("Connecting to browser");
  expect(host.querySelector('[data-query-view="error"]')).toBeNull();
  expect(host.textContent).not.toContain("tenant_app_unavailable");
  probe.mockResolvedValue({ reachable: true, retryAfterMs: null });
  vi.mocked(browserUseApi.viewer).mockResolvedValue({ url: "https://live.browser-use.com/test", viewport: "default" });
  await tick(1_000);
  await tick(1_000);
  expect(store.getSnapshot().status).toBe("online");
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://live.browser-use.com/test");
});
it("ignores a viewer response for a previous browser", async () => {
  let resolveFirst!: (value: { url: string; viewport: "default" }) => void;
  vi.mocked(browserUseApi.viewer).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
  await renderResilient();
  expect(host.querySelector("iframe")).toBeNull();
  vi.mocked(browserUseApi.viewer).mockResolvedValue({ url: "https://live.browser-use.com/second", viewport: "default" });
  await act(async () => root.render(<ConnectivityProvider store={store}><QueryClientProvider client={cache}><TooltipProvider><TaskBrowserPanel issueId="task" browser={{ ...browser, id: "browser-2" }} /></TooltipProvider></QueryClientProvider></ConnectivityProvider>));
  await act(async () => { resolveFirst({ url: "https://live.browser-use.com/first", viewport: "default" }); });
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://live.browser-use.com/second");
});
