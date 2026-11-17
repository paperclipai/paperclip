/** Minimal board API client for an isolated local_trusted instance. */
export function isSocketTypeOfServiceRace(error: unknown): boolean {
  const candidate = error as { code?: unknown; syscall?: unknown } | null;
  return candidate?.code === "EINVAL" && candidate.syscall === "setTypeOfService";
}

export class ChaosApiError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); this.name = "ChaosApiError"; }
}

export function rateLimitDelayMs(response: { status: number; headers: { get(name: string): string | null } }, text: string): number | null {
  if (response.status !== 429) return null;
  let seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    try { seconds = Number((JSON.parse(text) as { retryAfterSeconds?: unknown }).retryAfterSeconds); } catch { seconds = NaN; }
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(10_000, seconds * 1_000) : 1_000;
}

export class ChaosApi {
  constructor(readonly baseUrl: string, private readonly timeoutMs = 10_000, private readonly rateLimitAttempts = 5) {}

  private async request<T>(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs, text = false): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.attempt<T>(method, route, body, timeoutMs, text);
      if (!("retryAfterMs" in outcome)) return outcome.value;
      if (method !== "GET" || attempt >= this.rateLimitAttempts) throw outcome.error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10_000, outcome.retryAfterMs * attempt)));
    }
  }

  private async attempt<T>(method: string, route: string, body: unknown, timeoutMs: number, asText = false):
    Promise<{ value: T } | { retryAfterMs: number; error: ChaosApiError }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: { origin: this.baseUrl, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      throw new ChaosApiError(null, `${method} ${route} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const error = new ChaosApiError(response.status, `${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`);
      const retryAfterMs = rateLimitDelayMs(response, text);
      if (retryAfterMs !== null) return { retryAfterMs, error };
      throw error;
    }
    return { value: (asText ? text : text ? JSON.parse(text) : null) as T };
  }

  get<T>(route: string, timeoutMs?: number) { return this.request<T>("GET", route, undefined, timeoutMs); }
  getText(route: string, timeoutMs?: number) { return this.request<string>("GET", route, undefined, timeoutMs, true); }
  post<T>(route: string, body?: unknown, timeoutMs?: number) { return this.request<T>("POST", route, body ?? {}, timeoutMs); }
  put<T>(route: string, body?: unknown) { return this.request<T>("PUT", route, body ?? {}); }
  patch<T>(route: string, body?: unknown) { return this.request<T>("PATCH", route, body ?? {}); }
  async delete(route: string, options?: { allowNotFound?: boolean; timeout?: number }): Promise<void> {
    try { await this.request<unknown>("DELETE", route, undefined, options?.timeout); }
    catch (error) { if (!(options?.allowNotFound && error instanceof ChaosApiError && error.status === 404)) throw error; }
  }
}
