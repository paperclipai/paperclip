import type { ClassifierStatus } from "./monitor.js";

export interface ProbeOptions {
  url: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export function makeClassifierProbe(opts: ProbeOptions): () => Promise<ClassifierStatus> {
  const f = opts.fetchFn ?? fetch;
  return async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await f(`${opts.url}/v1/models`, { signal: ctrl.signal });
      return res.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  };
}
