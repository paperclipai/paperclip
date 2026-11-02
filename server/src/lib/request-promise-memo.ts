type RequestPromiseMemoOptions<TValue> = {
  shouldCache?: (value: TValue) => boolean;
};

export function createRequestPromiseMemo<TRequest extends object, TValue>(
  options: RequestPromiseMemoOptions<TValue> = {},
) {
  const requests = new WeakMap<TRequest, Map<string, Promise<TValue>>>();
  const shouldCache = options.shouldCache ?? (() => true);

  return function memoize(request: TRequest, key: string, load: () => Promise<TValue>) {
    let memo = requests.get(request);
    if (!memo) {
      memo = new Map();
      requests.set(request, memo);
    }

    const cached = memo.get(key);
    if (cached) return cached;

    const value = load();
    memo.set(key, value);
    void value.then(
      (resolved) => {
        if (!shouldCache(resolved) && memo.get(key) === value) memo.delete(key);
      },
      () => {
        if (memo.get(key) === value) memo.delete(key);
      },
    );
    return value;
  };
}
