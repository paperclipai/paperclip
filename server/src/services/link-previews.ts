import type { LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import type { LinkPreviewStore, StoredLinkPreview } from "./link-preview-store.js";
import { recognizeLinkPreview } from "@paperclipai/shared";

export interface LinkPreviewScope { companyId: string; userId: string | null }
export interface LinkPreviewProvider {
  key: string;
  resolve(target: LinkPreviewTarget, scope: LinkPreviewScope, signal: AbortSignal): Promise<LinkPreviewResult>;
}

const UNAVAILABLE: LinkPreviewResult = { preview: null, maxAgeMs: 60_000 };

/** Request-driven cache: durable across restarts, isolated by viewer, with no idle worker. */
export function createLinkPreviewService(providers: readonly LinkPreviewProvider[], options: {
  store?: LinkPreviewStore; now?: () => number; timeoutMs?: number; maxEntries?: number; maxConcurrent?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, StoredLinkPreview>();
  const inFlight = new Map<string, Promise<LinkPreviewResult>>();
  let activeOperations = 0;
  const byKey = new Map(providers.map(provider => [provider.key, provider]));

  function remember(key: string, entry: StoredLinkPreview) {
    if ((cache.get(key)?.checkedAt ?? -Infinity) > entry.checkedAt) return;
    cache.delete(key);
    while (cache.size >= (options.maxEntries ?? 1_000)) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
  }
  const keyOf = (scope: LinkPreviewScope, url: string) => JSON.stringify([scope.companyId, scope.userId, url]);
  const remaining = (entry: StoredLinkPreview) => ({ ...entry.result, maxAgeMs: Math.max(0, entry.expiresAt - now()) });
  const newest = (memory: StoredLinkPreview | undefined, stored: StoredLinkPreview | undefined) =>
    stored && (!memory || stored.checkedAt >= memory.checkedAt) ? stored : memory;

  return {
    async cached(scope: LinkPreviewScope, hrefs: readonly string[]) {
      const targets = [...new Map(hrefs.map(recognizeLinkPreview).filter(target => target && byKey.has(target.provider))
        .map(target => [target!.canonicalUrl, target!])).values()];
      const stored = await options.store?.read(scope, targets).catch(() => new Map<string, StoredLinkPreview>());
      const results: Record<string, LinkPreviewResult> = {};
      for (const target of targets) {
        const key = keyOf(scope, target.canonicalUrl);
        const memory = cache.get(key);
        const entry = newest(memory, stored?.get(target.canonicalUrl));
        if (entry) { remember(key, entry); results[target.canonicalUrl] = remaining(entry); }
        // A batch miss is not a provider result. A later lookup must still
        // check durable storage, which another replica may have populated.
        else cache.delete(key);
      }
      return { results };
    },
    async get(scope: LinkPreviewScope, href: string): Promise<LinkPreviewResult> {
      const target = recognizeLinkPreview(href);
      const provider = target && byKey.get(target.provider);
      if (!target || !provider) return UNAVAILABLE;
      const key = keyOf(scope, target.canonicalUrl);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return { ...cached.result, maxAgeMs: cached.expiresAt - now() };
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      if (activeOperations >= (options.maxConcurrent ?? 32)) return UNAVAILABLE;

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      let previous = cached;
      const checkedAt = now();
      let providerStarted = false;
      let storeWriteStarted = false;
      let durableReadSucceeded = !options.store;
      let timeoutWrite: Promise<void> | undefined;
      const fallback = (): LinkPreviewResult => ({ preview: newest(previous, cache.get(key))?.result.preview ?? null, maxAgeMs: 60_000 });
      const deadline = new Promise<LinkPreviewResult>(resolve => {
        timer = setTimeout(() => {
          const current = cache.get(key);
          if (current && current.checkedAt > checkedAt) {
            controller.abort();
            resolve(remaining(current));
            return;
          }
          const result = current && current.expiresAt > now() ? remaining(current) : fallback();
          const entry = { result, expiresAt: now() + result.maxAgeMs,
            checkedAt: durableReadSucceeded || storeWriteStarted ? checkedAt : previous?.checkedAt ?? 0 };
          remember(key, entry);
          // Publish timeout freshness without delaying the caller. The lookup
          // keeps its slot until both the provider and this write settle.
          if (options.store && durableReadSucceeded && providerStarted && !storeWriteStarted) {
            timeoutWrite = Promise.resolve().then(() => options.store!.write(scope, target, entry, checkedAt)).catch(() => {});
          }
          controller.abort();
          resolve(result);
        }, options.timeoutMs ?? 5_000);
      });
      // All underlying work, including uncancellable SQL, retains its slot until
      // settlement. The caller's deadline does not release the resource budget.
      activeOperations++;
      const operation = Promise.resolve().then(async () => {
        if (options.store) {
          // Fresh memory returned above. Expired memory is only a fallback:
          // another replica may have saved a newer result, even with a shorter TTL.
          const stored = await options.store.read(scope, [target]).catch(() => null);
          durableReadSucceeded = stored !== null;
          previous = newest(newest(previous, cache.get(key)), stored?.get(target.canonicalUrl));
          if (!controller.signal.aborted && previous) remember(key, previous);
        }
        if (controller.signal.aborted) return fallback();
        if (previous && previous.expiresAt > now()) { remember(key, previous); return remaining(previous); }
        providerStarted = true;
        const result = await provider.resolve(target, scope, controller.signal).catch(() => UNAVAILABLE);
        if (controller.signal.aborted) return fallback();
        // A page batch can hydrate another replica's newer status while the
        // provider is pending. That result wins over this older lookup.
        previous = newest(previous, cache.get(key));
        if (previous && previous.checkedAt > checkedAt) return remaining(previous);
        const bounded = { ...result, maxAgeMs: Math.max(1_000, Math.min(result.maxAgeMs, 60 * 60_000)) };
        if (!bounded.preview && previous?.result.preview) bounded.preview = previous.result.preview;
        const entry = { result: bounded, expiresAt: now() + bounded.maxAgeMs,
          checkedAt: durableReadSucceeded || result.preview ? checkedAt : previous?.checkedAt ?? 0 };
        remember(key, entry);
        // A failed durable read cannot establish which saved status a provider
        // failure would replace. Keep that backoff local until storage recovers.
        if (options.store && (durableReadSucceeded || result.preview)) {
          storeWriteStarted = true;
          await options.store.write(scope, target, entry, checkedAt).catch(() => {});
        }
        return remaining(entry);
      }).catch(fallback).finally(async () => { await timeoutWrite; activeOperations--; });
      const request = Promise.race([operation, deadline]).then(result => {
        const current = cache.get(key);
        // Hydration can also finish while the operation awaits its SQL write.
        if (current && current.checkedAt > checkedAt) return remaining(current);
        if (!current || current.expiresAt <= now()) remember(key, { result, expiresAt: now() + result.maxAgeMs, checkedAt });
        return result;
      }).finally(() => {
        clearTimeout(timer!);
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    },
  };
}
