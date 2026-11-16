import type { QueryClient } from "@tanstack/react-query";
import { LINK_PREVIEW_BATCH_LIMIT, type LinkPreviewBatchResult, type LinkPreviewResult, type LinkPreviewTarget } from "@paperclipai/shared";
import { linkPreviewQueryOptions, type LinkPreviewLoader } from "./link-preview-query";

export const MAX_PAGE_LINK_PREVIEWS = 200;
const PAGE_CONCURRENCY = 3;

export interface LinkPreviewPageEnvironment {
  loaded(): boolean;
  onLoad(callback: () => void): () => void;
  idle(callback: () => void): () => void;
}

export const browserLinkPreviewEnvironment: LinkPreviewPageEnvironment = {
  loaded: () => document.readyState === "complete" && document.visibilityState !== "hidden",
  onLoad: callback => {
    window.addEventListener("load", callback);
    document.addEventListener("visibilitychange", callback);
    return () => { window.removeEventListener("load", callback); document.removeEventListener("visibilitychange", callback); };
  },
  idle: callback => {
    // Let input, paint and the initial task requests finish. This is a one-shot
    // page event, not a recurring refresh loop.
    let cancel = () => {};
    const timer = setTimeout(() => {
      if (window.requestIdleCallback) {
        const id = window.requestIdleCallback(callback, { timeout: 2_000 });
        cancel = () => window.cancelIdleCallback(id);
      } else {
        const id = setTimeout(callback, 0);
        cancel = () => clearTimeout(id);
      }
    }, 500);
    return () => { clearTimeout(timer); cancel(); };
  },
};

/** One registry per authenticated company. Work is proportional to mounted unique links. */
export function createLinkPreviewPageLoader(client: QueryClient, context: LinkPreviewLoader & {
  readCached(targets: LinkPreviewTarget[]): Promise<LinkPreviewBatchResult>;
}, environment: LinkPreviewPageEnvironment = browserLinkPreviewEnvironment) {
  const links = new Map<string, { target: LinkPreviewTarget; count: number; hydrated: boolean; attempted: boolean }>();
  let disposed = false;
  let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
  let hydrating = false;
  let active = 0;
  let cancelIdle: (() => void) | undefined;

  const busy = () => client.isFetching({ predicate: query => query.queryKey[0] !== "link-preview" }) > 0;
  function scheduleIdle() {
    if (disposed || cancelIdle || hydrating || active >= PAGE_CONCURRENCY || !environment.loaded() || busy()
      || ![...links.values()].some(link => link.hydrated && !link.attempted)) return;
    cancelIdle = environment.idle(() => {
      cancelIdle = undefined;
      if (disposed || !environment.loaded() || busy()) return;
      for (const link of links.values()) {
        if (!link.hydrated || link.attempted) continue;
        if (active >= PAGE_CONCURRENCY) break;
        link.attempted = true;
        active++;
        void client.fetchQuery(linkPreviewQueryOptions(context, link.target)).catch(() => {}).finally(() => { active--; scheduleIdle(); });
      }
    });
  }
  function scheduleHydration() {
    if (disposed || hydrating || hydrationTimer !== undefined) return;
    hydrationTimer = setTimeout(() => {
      hydrationTimer = undefined;
      for (const link of links.values()) {
        if (!link.hydrated && client.getQueryData(linkPreviewQueryOptions(context, link.target).queryKey) !== undefined) link.hydrated = true;
      }
      const batch: Array<{ target: LinkPreviewTarget; count: number; hydrated: boolean; attempted: boolean }> = [];
      let bytes = 0;
      for (const link of links.values()) {
        if (link.hydrated) continue;
        const size = encodeURIComponent(link.target.canonicalUrl).length + 5;
        if (batch.length >= LINK_PREVIEW_BATCH_LIMIT || bytes + size > 6_000) break;
        batch.push(link); bytes += size;
      }
      if (!batch.length) { scheduleIdle(); return; }
      hydrating = true;
      const startedAt = Date.now();
      for (const link of batch) link.hydrated = true;
      const targets = batch.map(link => link.target);
      // A renderer can remount while a batch is pending. Keep the read on the
      // shared client so both lifetimes reuse the same HTTP request.
      void client.fetchQuery({
        queryKey: ["link-preview", context.companyId, context.userId, "cached-batch", targets.map(target => target.canonicalUrl).sort()],
        queryFn: () => context.readCached(targets), staleTime: 0, gcTime: 0,
        retry: false, // query-error-ok: Optional hydration must settle within one deadline so idle enrichment can continue when the cache is unavailable.
      }).then(({ results }) => {
        if (disposed) return;
        for (const link of batch) {
          const mounted = links.get(link.target.canonicalUrl);
          if (!mounted) continue;
          mounted.hydrated = true;
          const options = linkPreviewQueryOptions(context, link.target);
          const state = client.getQueryState<LinkPreviewResult>(options.queryKey);
          const saved = results[link.target.canonicalUrl];
          // Never replace a hover result that arrived during the database read.
          if (saved && state?.fetchStatus !== "fetching" && (!state || state.dataUpdatedAt <= startedAt)
            && (!state?.data || state.dataUpdatedAt + state.data.maxAgeMs <= Date.now() + saved.maxAgeMs)) {
            client.setQueryData(options.queryKey, saved);
          }
        }
      }).catch(() => {}).finally(() => {
        hydrating = false;
        scheduleHydration();
        scheduleIdle();
      });
    }, 0);
  }
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] !== "link-preview") scheduleIdle();
  });
  const offLoad = environment.onLoad(scheduleIdle);
  return {
    register(target: LinkPreviewTarget) {
      let link = links.get(target.canonicalUrl);
      if (!link && links.size < MAX_PAGE_LINK_PREVIEWS) {
        link = { target, count: 0, hydrated: false, attempted: false };
        links.set(target.canonicalUrl, link);
      }
      if (!link) return () => {};
      link.count++;
      scheduleHydration();
      return () => {
        if (--link.count === 0) links.delete(target.canonicalUrl);
        if (!links.size) { cancelIdle?.(); cancelIdle = undefined; }
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(hydrationTimer);
      cancelIdle?.();
      unsubscribe(); offLoad(); links.clear();
    },
  };
}
