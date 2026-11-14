import type { LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import { recognizeLinkPreview } from "@paperclipai/shared";

export interface LinkPreviewScope { companyId: string; userId: string | null }
export interface LinkPreviewProvider {
  key: string;
  resolve(target: LinkPreviewTarget, scope: LinkPreviewScope, signal: AbortSignal): Promise<LinkPreviewResult>;
}

const UNAVAILABLE: LinkPreviewResult = { preview: null, maxAgeMs: 60_000 };

/** Request-driven and process-local. No DB writes, sweep, timers while idle, or cross-viewer reuse. */
export function createLinkPreviewService(providers: readonly LinkPreviewProvider[], options: {
  now?: () => number; timeoutMs?: number; maxEntries?: number; maxConcurrent?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { result: LinkPreviewResult; expiresAt: number }>();
  const inFlight = new Map<string, Promise<LinkPreviewResult>>();
  let activeOperations = 0;
  const byKey = new Map(providers.map(provider => [provider.key, provider]));

  return {
    async get(scope: LinkPreviewScope, href: string): Promise<LinkPreviewResult> {
      const target = recognizeLinkPreview(href);
      const provider = target && byKey.get(target.provider);
      if (!target || !provider) return UNAVAILABLE;
      const key = JSON.stringify([scope.companyId, scope.userId, target.canonicalUrl]);
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
      const operation = Promise.resolve().then(() => provider.resolve(target, scope, controller.signal))
        .catch(() => UNAVAILABLE).finally(() => { activeOperations--; });
      const request = Promise.race([operation, deadline]).then(result => {
        const bounded = { ...result, maxAgeMs: Math.max(1_000, Math.min(result.maxAgeMs, 60 * 60_000)) };
        cache.delete(key);
        while (cache.size >= (options.maxEntries ?? 1_000)) cache.delete(cache.keys().next().value!);
        cache.set(key, { result: bounded, expiresAt: now() + bounded.maxAgeMs });
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
