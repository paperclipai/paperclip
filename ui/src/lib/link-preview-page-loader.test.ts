import { QueryClient } from "@tanstack/react-query";
import { recognizeLinkPreview, type LinkPreviewResult, type LinkPreviewTarget } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkPreviewPageLoader, MAX_PAGE_LINK_PREVIEWS, type LinkPreviewPageEnvironment } from "./link-preview-page-loader";
import { linkPreviewQueryOptions } from "./link-preview-query";

const target = recognizeLinkPreview("https://github.com/acme/web/pull/42")!;
const result: LinkPreviewResult = { preview: { target, title: "Saved status", state: "merged", author: null, updatedAt: null }, maxAgeMs: 60_000 };
const disposers: Array<() => void> = [];
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let loaded = false;
  let onLoad = () => {};
  const idle = new Set<() => void>();
  const environment: LinkPreviewPageEnvironment = {
    loaded: () => loaded, onLoad: cb => { onLoad = cb; return () => { onLoad = () => {}; }; },
    idle: cb => { idle.add(cb); return () => { idle.delete(cb); }; },
  };
  const context = { companyId: "company-a", userId: "alice", load: vi.fn(async () => result), readCached: vi.fn(async (_targets: LinkPreviewTarget[]) => ({ results: {} as Record<string, LinkPreviewResult> })) };
  const loader = createLinkPreviewPageLoader(client, context, environment);
  disposers.push(() => { loader.dispose(); client.clear(); });
  return { client, context, loader, idle,
    loaded() { loaded = true; onLoad(); },
    runIdle() { const callbacks = [...idle]; idle.clear(); callbacks.forEach(cb => cb()); },
  };
}
async function settle() { await vi.advanceTimersByTimeAsync(1); }

beforeEach(() => vi.useFakeTimers());
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
describe("page link enrichment", () => {
  it("hydrates duplicate links in one batch before load, then reuses fresh status without a provider request", async () => {
    const f = fixture();
    f.context.readCached.mockResolvedValue({ results: { [target.canonicalUrl]: result } });
    for (let i = 0; i < 500; i++) f.loader.register(target);
    expect(f.context.readCached).not.toHaveBeenCalled();
    await settle();
    expect(f.context.readCached).toHaveBeenCalledExactlyOnceWith([target]);
    expect(f.client.getQueryData(linkPreviewQueryOptions(f.context, target).queryKey)).toEqual(result);
    expect(f.idle.size).toBe(0);
    f.loaded(); f.runIdle(); await settle();
    expect(f.context.load).not.toHaveBeenCalled();
  });
  it("waits for core page queries and load, then resolves without hover and stays quiet", async () => {
    const f = fixture();
    let finish!: (value: number) => void;
    const core = f.client.fetchQuery({ queryKey: ["issues", "detail", "42"], queryFn: () => new Promise<number>(done => { finish = done; }) });
    f.loader.register(target); f.loaded(); await settle();
    expect(f.context.load).not.toHaveBeenCalled(); expect(f.idle.size).toBe(0);
    finish(1); await core; expect(f.idle.size).toBe(1);
    f.runIdle(); await settle(); expect(f.context.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); f.loaded(); f.runIdle(); await settle();
    expect(f.context.load).toHaveBeenCalledTimes(1);
  });
  it("shows stale saved status and coalesces an overlapping hover/idle lookup", async () => {
    const f = fixture();
    f.context.readCached.mockResolvedValue({ results: { [target.canonicalUrl]: { ...result, maxAgeMs: 0 } } });
    let finish!: (value: LinkPreviewResult) => void;
    f.context.load.mockImplementation(() => new Promise(done => { finish = done; }));
    f.loader.register(target); f.loaded(); await settle();
    expect(f.client.getQueryData<LinkPreviewResult>(linkPreviewQueryOptions(f.context, target).queryKey)?.preview?.state).toBe("merged");
    const hover = f.client.fetchQuery(linkPreviewQueryOptions(f.context, target));
    f.runIdle(); await settle(); expect(f.context.load).toHaveBeenCalledTimes(1);
    finish(result); await hover; await settle(); expect(f.idle.size).toBe(0);
  });
  it("does not replace newer hover status with a slower cache read", async () => {
    const f = fixture();
    let finish!: (value: { results: Record<string, LinkPreviewResult> }) => void;
    f.context.readCached.mockImplementation(() => new Promise(done => { finish = done; }));
    f.loader.register(target); await settle();
    await f.client.fetchQuery(linkPreviewQueryOptions(f.context, target));
    finish({ results: { [target.canonicalUrl]: { ...result, preview: { ...result.preview!, state: "open" }, maxAgeMs: 0 } } });
    await settle();
    expect(f.client.getQueryData<LinkPreviewResult>(linkPreviewQueryOptions(f.context, target).queryKey)?.preview?.state).toBe("merged");
  });
  it("bounds a large page, batches SQL cache reads, and limits provider concurrency", async () => {
    const f = fixture();
    f.context.load.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 1000; i++) f.loader.register(recognizeLinkPreview(target.canonicalUrl + i)!);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.context.readCached.mock.calls.flatMap(([targets]) => targets)).toHaveLength(MAX_PAGE_LINK_PREVIEWS);
    expect(f.context.readCached.mock.calls.every(([targets]) => targets.length <= 50)).toBe(true);
    f.loaded(); f.runIdle(); await settle();
    expect(f.context.load).toHaveBeenCalledTimes(3);
    expect(f.idle.size).toBe(0);
  });
  it("removes departed links and ignores late hydration after navigation or account change", async () => {
    const f = fixture();
    const unregister = f.loader.register(target);
    unregister(); f.loaded(); await settle(); f.runIdle();
    expect(f.context.readCached).not.toHaveBeenCalled(); expect(f.context.load).not.toHaveBeenCalled();
    let finish!: (value: { results: Record<string, LinkPreviewResult> }) => void;
    f.context.readCached.mockImplementation(() => new Promise(done => { finish = done; }));
    f.loader.register(target); await settle(); f.loader.dispose();
    finish({ results: { [target.canonicalUrl]: result } }); await settle();
    expect(f.client.getQueryData(linkPreviewQueryOptions(f.context, target).queryKey)).toBeUndefined();
  });
  it("shares a pending database read when the same URL remounts", async () => {
    const f = fixture();
    let finish!: (value: { results: Record<string, LinkPreviewResult> }) => void;
    f.context.readCached.mockImplementation(() => new Promise(done => { finish = done; }));
    const unregister = f.loader.register(target); await settle();
    unregister(); f.loader.register(target); await settle();
    finish({ results: { [target.canonicalUrl]: result } }); await settle();
    expect(f.context.readCached).toHaveBeenCalledTimes(1);
    expect(f.client.getQueryData(linkPreviewQueryOptions(f.context, target).queryKey)).toEqual(result);
  });
  it("retains saved status when automatic refresh has a network error", async () => {
    const f = fixture();
    f.client.setQueryData(linkPreviewQueryOptions(f.context, target).queryKey, { ...result, maxAgeMs: 0 });
    f.context.load.mockRejectedValue(new Error("network unavailable"));
    f.loader.register(target); f.loaded(); await settle(); f.runIdle(); await settle();
    expect(f.client.getQueryData<LinkPreviewResult>(linkPreviewQueryOptions(f.context, target).queryKey)?.preview).toEqual(result.preview);
    expect(f.context.readCached).not.toHaveBeenCalled();
  });
  it("bounds encoded batch URLs for long resource names", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.loader.register(recognizeLinkPreview(`https://github.com/acme/${"a".repeat(1900)}/pull/${i + 1}`)!);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.context.readCached.mock.calls.flatMap(([targets]) => targets)).toHaveLength(100);
    expect(f.context.readCached.mock.calls.every(([targets]) => targets.reduce((n, target) => n + encodeURIComponent(target.canonicalUrl).length + 5, 0) <= 6_000)).toBe(true);
  });
  it("keeps failures quiet and lets hover work when cached hydration fails", async () => {
    const f = fixture();
    f.context.readCached.mockRejectedValue(new Error("cache unavailable"));
    f.loader.register(target); f.loaded(); await settle(); f.runIdle(); await settle();
    expect(f.context.load).toHaveBeenCalledTimes(1);
    expect(f.client.getQueryData(linkPreviewQueryOptions(f.context, target).queryKey)).toEqual(result);
  });
});
