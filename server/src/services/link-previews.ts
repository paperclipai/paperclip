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
  const cache = new Map<string, { result: LinkPreviewResult; expiresAt: number }>();
  const inFlight = new Map<string, Promise<LinkPreviewResult>>();
  let activeOperations = 0;
  const byKey = new Map(providers.map(provider => [provider.key, provider]));

  function remember(key: string, entry: StoredLinkPreview) {
    cache.delete(key);
    while (cache.size >= (options.maxEntries ?? 1_000)) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
  }
  const keyOf = (scope: LinkPreviewScope, url: string) => JSON.stringify([scope.companyId, scope.userId, url]);
  const remaining = (entry: StoredLinkPreview) => ({ ...entry.result, maxAgeMs: Math.max(0, entry.expiresAt - now()) });

  return {
    async cached(scope: LinkPreviewScope, hrefs: readonly string[]) {
      const targets = [...new Map(hrefs.map(recognizeLinkPreview).filter(target => target && byKey.has(target.provider))
        .map(target => [target!.canonicalUrl, target!])).values()];
      const stored = await options.store?.read(scope, targets).catch(() => new Map<string, StoredLinkPreview>());
      const results: Record<string, LinkPreviewResult> = {};
      for (const target of targets) {
        const key = keyOf(scope, target.canonicalUrl);
        const memory = cache.get(key);
        const entry = memory && memory.expiresAt > now() ? memory : stored?.get(target.canonicalUrl) ?? memory;
        if (entry) { remember(key, entry); results[target.canonicalUrl] = remaining(entry); }
        else remember(key, { result: UNAVAILABLE, expiresAt: 0 });
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
      const deadline = new Promise<LinkPreviewResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(UNAVAILABLE); }, options.timeoutMs ?? 5_000);
      });
      // Keep an underlying operation in the concurrency budget until it settles,
      // even if a credential backend ignores cancellation after our deadline.
      activeOperations++;
      let previous = cached;
      let restored = false;
      const checkedAt = now();
      const operation = Promise.resolve().then(async () => {
        if (!previous && options.store) {
          previous = (await options.store.read(scope, [target]).catch(() => new Map<string, StoredLinkPreview>())).get(target.canonicalUrl);
        }
        if (previous && previous.expiresAt > now()) { restored = true; return remaining(previous); }
        if (controller.signal.aborted) return UNAVAILABLE;
        return provider.resolve(target, scope, controller.signal);
      }).catch(() => UNAVAILABLE).finally(() => { activeOperations--; });
      const request = Promise.race([operation, deadline]).then(async result => {
        if (restored && previous) { remember(key, previous); return remaining(previous); }
        const bounded = { ...result, maxAgeMs: Math.max(1_000, Math.min(result.maxAgeMs, 60 * 60_000)) };
        // An outage must not erase the last known status; negative freshness still applies.
        if (!bounded.preview && previous?.result.preview) bounded.preview = previous.result.preview;
        const entry = { result: bounded, expiresAt: now() + bounded.maxAgeMs };
        remember(key, entry);
        if (options.store && !(previous && previous.expiresAt > now())) {
          await options.store.write(scope, target, entry, checkedAt).catch(() => {});
        }
        return bounded;
      }).finally(() => {
        clearTimeout(timer!);
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    },
  };
}
