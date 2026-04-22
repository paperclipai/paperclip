import type { FastifyInstance } from "fastify";

export type ClassifierStatus = "reachable" | "unreachable";

export interface HealthOptions {
  classifierUrl: string;
  fetchFn?: typeof fetch;
  pingTimeoutMs?: number;
}

const CACHE_MS = 10_000;

export function registerHealthRoute(app: FastifyInstance, opts: HealthOptions): void {
  const f = opts.fetchFn ?? fetch;
  const timeout = opts.pingTimeoutMs ?? 3_000;
  let cachedAt = 0;
  let cached: ClassifierStatus = "unreachable";

  async function probe(): Promise<ClassifierStatus> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await f(`${opts.classifierUrl}/v1/models`, { signal: ctrl.signal });
      return res.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/health", { config: { noAuth: true } }, async () => {
    const now = Date.now();
    if (now - cachedAt > CACHE_MS) {
      cached = await probe();
      cachedAt = now;
    }
    return { status: "ok", classifier: cached };
  });
}
