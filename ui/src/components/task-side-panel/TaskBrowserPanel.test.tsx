// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
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
