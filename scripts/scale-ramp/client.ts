import { assertSameOrigin, type Target } from "./guard.ts";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export interface RequestRecord {
  at: number;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  ok: boolean;
  kind: "board" | "harness";
}

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(status: number | null, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class Redactor {
  private readonly values: string[];

  constructor(values: ReadonlyArray<string | null | undefined>) {
    this.values = values.filter((value): value is string => typeof value === "string" && value.length >= 4)
      .sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let out = input;
    for (const value of this.values) out = out.split(value).join("[redacted]");
    return out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  }

  json<T>(value: T): T {
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TRANSIENT = new Set([502, 503, 504]);

export function pathClass(route: string): string {
  return route.split("?")[0]!.replace(UUID, ":id");
}

export class PaperclipClient {
  readonly records: RequestRecord[] = [];
  private readonly target: Target;
  private readonly token: string;
  private readonly fetcher: Fetcher;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly timeoutMs: number;

  constructor(target: Target, token: string, fetcher: Fetcher, clock: Clock, redactor: Redactor, timeoutMs = 30_000) {
    this.target = target;
    this.token = token;
    this.fetcher = fetcher;
    this.clock = clock;
    this.redactor = redactor;
    this.timeoutMs = timeoutMs;
  }

  private async once(method: string, route: string, body: unknown, kind: RequestRecord["kind"]) {
    const url = `${this.target.baseUrl}${route}`;
    assertSameOrigin(this.target, url);
    const started = this.clock.now();
    try {
      const response = await this.fetcher(url, {
        method,
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          origin: this.target.baseUrl,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const ms = this.clock.now() - started;
      const answered = response.ok || (kind === "harness" && [400, 404, 409, 422].includes(response.status));
      this.records.push({ at: started, method, path: pathClass(route), status: response.status, ms, ok: answered, kind });
      return { status: response.status, ok: response.ok, text };
    } catch (error) {
      this.records.push({ at: started, method, path: pathClass(route), status: null, ms: this.clock.now() - started, ok: false, kind });
      return { status: null, ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }

  async request<T>(method: string, route: string, body?: unknown, kind: RequestRecord["kind"] = "harness"): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.once(method, route, body, kind);
      if (result.ok) return (result.text ? JSON.parse(result.text) : null) as T;
      const transient = result.status === null || TRANSIENT.has(result.status) || result.status === 429;
      if (!transient || (method !== "GET" && result.status !== 429) || attempt >= 3) {
        let code: string | null = null;
        try {
          const parsed = JSON.parse(result.text) as { code?: unknown; details?: { code?: unknown } };
          code = typeof parsed.code === "string" ? parsed.code : typeof parsed.details?.code === "string" ? parsed.details.code : null;
        } catch {
          code = null;
        }
        const detail = this.redactor.text(result.text.slice(0, 300));
        throw new ApiError(result.status, `${method} ${pathClass(route)} ${result.status === null ? "got no answer" : `returned ${result.status}`}: ${detail}`, code);
      }
      await this.clock.sleep(1_000 * attempt);
    }
  }

  get<T>(route: string, kind: RequestRecord["kind"] = "harness") {
    return this.request<T>("GET", route, undefined, kind);
  }

  post<T>(route: string, body: unknown = {}) {
    return this.request<T>("POST", route, body);
  }

  patch<T>(route: string, body: unknown = {}) {
    return this.request<T>("PATCH", route, body);
  }

  async delete(route: string, allowNotFound = true): Promise<void> {
    try {
      await this.request<unknown>("DELETE", route);
    } catch (error) {
      if (!(allowNotFound && error instanceof ApiError && error.status === 404)) throw error;
    }
  }
}

export async function readMetrics(fetcher: Fetcher, url: string, token: string | null, clock: Clock): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>), sampledAt: clock.now() } : null;
  } catch {
    return null;
  }
}
