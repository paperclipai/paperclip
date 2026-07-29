export type PromiseMemoEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

export function memoizePromise<T>(input: {
  cache: Map<string, PromiseMemoEntry<T>>;
  key: string;
  ttlMs: number;
  maxEntries: number;
  load: () => Promise<T>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const cached = input.cache.get(input.key);
  if (cached?.expiresAt && cached.expiresAt > now) return cached.value;
  if (cached) input.cache.delete(input.key);

  if (input.cache.size >= input.maxEntries) {
    for (const [key, entry] of input.cache) {
      if (entry.expiresAt <= now) input.cache.delete(key);
    }
    while (input.cache.size >= input.maxEntries) {
      const oldestKey = input.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      input.cache.delete(oldestKey);
    }
  }

  const entry: PromiseMemoEntry<T> = {
    expiresAt: now + input.ttlMs,
    value: input.load(),
  };
  input.cache.set(input.key, entry);
  void entry.value.catch(() => {
    if (input.cache.get(input.key) === entry) input.cache.delete(input.key);
  });
  return entry.value;
}
