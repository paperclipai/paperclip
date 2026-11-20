import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApiError, rateLimitDelayMs } from "./api.js";
import { assertSameOrigin, type HostedTarget } from "./hosted-guard.js";
import type { HealthSample } from "./hosted-release.js";

export const HOSTED_TOKEN_ENV = "PAPERCLIP_HOSTED_TOKEN";
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
export const ANSWERED_REFUSALS: ReadonlySet<number> = new Set([400, 404, 409, 422]);

export function hostedAuthPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = [path.join(os.homedir(), ".paperclip", "auth.json")];
  if (env.PAPERCLIP_HOME) paths.unshift(path.join(env.PAPERCLIP_HOME, "auth.json"));
  return [...new Set(paths)];
}

export function hostedToken(target: HostedTarget, env: NodeJS.ProcessEnv = process.env, authPaths = hostedAuthPaths(env)): string {
  const fromEnv = env[HOSTED_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  for (const authPath of authPaths) {
    let store: { credentials?: Record<string, { apiBase?: string; token?: string }> } = {};
    try { store = JSON.parse(readFileSync(authPath, "utf8")); } catch { continue; }
    const entry = store.credentials?.[target.baseUrl] ?? store.credentials?.[`${target.baseUrl}/`];
    if (entry?.token) return entry.token;
  }
  throw new Error(`No board sign-in for ${target.baseUrl} in ${authPaths.join(" or ")} (credentials["${target.baseUrl}"].token) and ${HOSTED_TOKEN_ENV} is unset. `
    + "Ask the owner to approve a board sign-in for this host first (README: Hosted mode, Sign-in).");
}

export interface RequestRecord { at: number; ok: boolean; reachable: boolean; status: number | null; ms: number; method: string; kind: "health" | "api"; path: string }

export function pathClass(route: string): string {
  return route.split("?")[0]!.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

export class HostedApi {
  readonly requests: RequestRecord[] = [];

  constructor(readonly target: HostedTarget, private readonly token: string, private readonly timeoutMs = 20_000,
    private readonly fetcher: typeof fetch = fetch) {}

  get baseUrl(): string { return this.target.baseUrl; }

  private async once(method: string, route: string, body: unknown, timeoutMs: number): Promise<{ status: number | null; text: string; retryAfterMs: number | null; record: RequestRecord }> {
    const url = `${this.target.baseUrl}${route}`;
    assertSameOrigin(this.target, url);
    const started = Date.now();
    try {
      const response = await this.fetcher(url, { method, cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", origin: this.target.baseUrl,
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      const record: RequestRecord = { at: started, ok: response.ok || (route !== "/api/health" && ANSWERED_REFUSALS.has(response.status)), reachable: response.status < 500, status: response.status,
        ms: Date.now() - started, method, kind: route === "/api/health" ? "health" : "api", path: pathClass(route) };
      this.requests.push(record);
      return { status: response.ok ? 200 : response.status, text, retryAfterMs: rateLimitDelayMs(response, text), record };
    } catch (error) {
      const record: RequestRecord = { at: started, ok: false, reachable: false, status: null, ms: Date.now() - started, method, kind: route === "/api/health" ? "health" : "api", path: pathClass(route) };
      this.requests.push(record);
      return { status: null, text: error instanceof Error ? error.message : String(error), retryAfterMs: null, record };
    }
  }

  private async request<T>(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.once(method, route, body, timeoutMs);
      if (result.status === 200) return (result.text ? JSON.parse(result.text) : null) as T;
      const transient = result.status === null || TRANSIENT_STATUSES.has(result.status) || result.retryAfterMs !== null;
      const error = new ChaosApiError(result.status, result.status === null ? `${method} ${route} unreachable: ${result.text.slice(0, 200)}`
        : `${method} ${route} returned ${result.status}: ${result.text.slice(0, 500)}`);
      if (!transient || (method !== "GET" && result.retryAfterMs === null) || attempt >= 4) throw error;
      await delay(Math.min(10_000, (result.retryAfterMs ?? 1_000) * attempt));
    }
  }

  get<T>(route: string, timeoutMs?: number) { return this.request<T>("GET", route, undefined, timeoutMs); }
  post<T>(route: string, body?: unknown, timeoutMs?: number) { return this.request<T>("POST", route, body ?? {}, timeoutMs); }
  patch<T>(route: string, body?: unknown) { return this.request<T>("PATCH", route, body ?? {}); }
  put<T>(route: string, body?: unknown) { return this.request<T>("PUT", route, body ?? {}); }
  async delete(route: string, options?: { allowNotFound?: boolean }): Promise<void> {
    try { await this.request<unknown>("DELETE", route); }
    catch (error) { if (!(options?.allowNotFound && error instanceof ChaosApiError && error.status === 404)) throw error; }
  }

  async health(): Promise<HealthSample> {
    const at = Date.now();
    const result = await this.once("GET", "/api/health", undefined, 10_000);
    const ms = Date.now() - at;
    if (result.status !== 200) return { at, ok: false, status: result.status, ms, processStartedAt: null, commit: null, error: result.text.slice(0, 200) };
    try {
      const body = JSON.parse(result.text) as { commit?: string; serverInfo?: { processStartedAt?: string } };
      return { at, ok: true, status: 200, ms, processStartedAt: body.serverInfo?.processStartedAt ?? null, commit: body.commit ?? null };
    } catch (error) {
      result.record.ok = false;
      return { at, ok: false, status: 200, ms, processStartedAt: null, commit: null, error: `unparseable health: ${String(error)}` };
    }
  }
}

export class HealthProbe {
  readonly samples: HealthSample[] = [];
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly api: Pick<HostedApi, "health">, private readonly intervalMs = 2_000,
    private readonly onSample: (sample: HealthSample) => void = () => {}) {}

  start(): this {
    this.loop = (async () => {
      while (!this.stopped) {
        const started = Date.now();
        const sample = await this.api.health();
        this.samples.push(sample);
        this.onSample(sample);
        const wait = this.intervalMs - (Date.now() - started);
        if (wait > 0 && !this.stopped) await delay(wait);
      }
    })();
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

export const apiRequests = (records: readonly RequestRecord[]) => records.filter(record => record.kind === "api");

export function requestSamples(records: readonly RequestRecord[]): HealthSample[] {
  return records.map(record => ({ at: record.at, ok: record.ok, status: record.status, ms: record.ms, processStartedAt: null, commit: null }));
}

export interface RequestBreakdown {
  requests: number;
  failures: number;
  byStatus: Record<string, number>;
  insideReleases: number;
  outsideReleases: number;
  outside: Array<{ at: string; method: string; path: string; status: number | null }>;
}

export function requestBreakdown(records: readonly RequestRecord[], windows: ReadonlyArray<{ from: number; to: number }>): RequestBreakdown {
  const failed = records.filter(record => !record.ok);
  const inside = (at: number) => windows.some(window => at >= window.from && at <= window.to);
  const byStatus: Record<string, number> = {};
  for (const record of failed) byStatus[String(record.status ?? "no answer")] = (byStatus[String(record.status ?? "no answer")] ?? 0) + 1;
  const outside = failed.filter(record => !inside(record.at));
  return { requests: records.length, failures: failed.length, byStatus, insideReleases: failed.length - outside.length, outsideReleases: outside.length,
    outside: outside.slice(0, 50).map(record => ({ at: new Date(record.at).toISOString(), method: record.method, path: record.path, status: record.status })) };
}
