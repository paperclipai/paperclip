// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PAGE_SETTLED_MAX_WAIT_MS, usePageSettled } from "./usePageSettled";

let root: Root, container: HTMLDivElement, client: QueryClient;
let settled: boolean[] = [];
function Probe() {
  settled.push(usePageSettled());
  return null;
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // Frames and idle callbacks run on the fake clock.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => setTimeout(cb, 50) as unknown as number);
  vi.stubGlobal("cancelIdleCallback", (id: number) => clearTimeout(id));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  settled = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("turns true after the page paints and its reads finish", async () => {
  let finish!: (value: string) => void;
  void client.fetchQuery({ queryKey: ["first-frame"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) }).catch(() => {});
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(settled.at(-1)).toBe(false);
  await act(async () => { finish("done"); await vi.advanceTimersByTimeAsync(100); });
  expect(settled.at(-1)).toBe(true);
});

it("turns true after the maximum wait on a page that keeps reading", async () => {
  void client.fetchQuery({ queryKey: ["never"], queryFn: () => new Promise<string>(() => {}) }).catch(() => {});
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(PAGE_SETTLED_MAX_WAIT_MS - 10); });
  expect(settled.at(-1)).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(settled.at(-1)).toBe(true);
});
