/** Minimal board API client for an isolated local_trusted instance. */
export function isSocketTypeOfServiceRace(error: unknown): boolean {
  const candidate = error as { code?: unknown; syscall?: unknown } | null;
  return candidate?.code === "EINVAL" && candidate.syscall === "setTypeOfService";
}

export class ChaosApiError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); this.name = "ChaosApiError"; }
}

export class ChaosApi {
  constructor(readonly baseUrl: string, private readonly timeoutMs = 10_000) {}

  private async request<T>(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
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
    if (!response.ok) throw new ChaosApiError(response.status, `${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(route: string, timeoutMs?: number) { return this.request<T>("GET", route, undefined, timeoutMs); }
  post<T>(route: string, body?: unknown, timeoutMs?: number) { return this.request<T>("POST", route, body ?? {}, timeoutMs); }
  put<T>(route: string, body?: unknown) { return this.request<T>("PUT", route, body ?? {}); }
  patch<T>(route: string, body?: unknown) { return this.request<T>("PATCH", route, body ?? {}); }
  async delete(route: string, options?: { allowNotFound?: boolean; timeout?: number }): Promise<void> {
    try { await this.request<unknown>("DELETE", route, undefined, options?.timeout); }
    catch (error) { if (!(options?.allowNotFound && error instanceof ChaosApiError && error.status === 404)) throw error; }
  }
}
