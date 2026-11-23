import { randomUUID } from "node:crypto";
import dc from "node:diagnostics_channel";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

export const REQUEST_ID_HEADER = "x-restart-chaos-request";
export const CONTROL_URL = "https://www.cloudflare.com/cdn-cgi/trace";
export const CONTROL_TIMEOUT_MS = 5_000;
export const STALL_MS = 1_000;
export const BODY_EXCERPT_BYTES = 512;
export const ERROR_BODY_READ_BYTES = 16 * 1024;
export const RETRY_TIMEOUT_MS = 2_000;
export const EVIDENCE_HEADERS = ["x-paperclip-status", "retry-after", "server", "via", "x-railway-request-id", "x-railway-edge", "cf-ray", "date", "content-type",
  "cache-control", "connection"] as const;

export interface SocketSnapshot { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number; remoteFamily?: string; bytesWritten?: number; bytesRead?: number }
export interface ErrorCause { name: string; message: string; code?: string; errno?: number; syscall?: string; hostname?: string; address?: string; port?: number;
  socket?: SocketSnapshot; causes?: ErrorCause[] }
export interface ConnectionInfo { reused: boolean | null; remoteAddress: string | null; remotePort: number | null; localAddress: string | null; localPort: number | null;
  dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null }
export interface AnswerEvidence { status: number; headers: Record<string, string>; bodyExcerpt: string; error: string | null; statusPageCode: string | null }
export interface ClientClock { timeoutMs: number; elapsedMs: number; monotonicMs: number; timerLagMs: number | null; clockJumpMs: number; loopDelayMaxMs: number | null;
  gapBeforeMs: number | null; intervalMs: number | null }
export interface FollowUp { url: string; ok: boolean; status: number | null; ms: number; error: ErrorCause | null; remoteAddress: string | null }
export interface FailureDiagnosis { url: string; method: string; aborted: boolean; answer: AnswerEvidence | null; cause: ErrorCause | null; connection: ConnectionInfo | null;
  clock: ClientClock; control: FollowUp | null; retry: FollowUp | null; controlReachedThisRun: boolean }
export type FailureClass = "client" | "server" | "unclassified";
export interface Classified { class: FailureClass; reason: string }
export type FailureRecord = FailureDiagnosis & Classified & { state: "pending" | "settled" };
export const isClientSide = (failure: FailureRecord | null | undefined) => failure?.state === "settled" && failure.class === "client";
export interface ProbeContext { gapBeforeMs: number | null; intervalMs: number | null }

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

const pick = <T>(value: unknown, type: "string" | "number"): T | undefined => typeof value === type ? value as T : undefined;

export function socketSnapshot(socket: unknown): SocketSnapshot | undefined {
  if (!socket || typeof socket !== "object") return undefined;
  const raw = socket as Record<string, unknown>;
  const snapshot: SocketSnapshot = { localAddress: pick(raw.localAddress, "string"), localPort: pick(raw.localPort, "number"), remoteAddress: pick(raw.remoteAddress, "string"),
    remotePort: pick(raw.remotePort, "number"), remoteFamily: pick(raw.remoteFamily, "string"), bytesWritten: pick(raw.bytesWritten, "number"), bytesRead: pick(raw.bytesRead, "number") };
  const kept = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined));
  return Object.keys(kept).length ? kept : undefined;
}

function describeError(error: unknown, depth: number): ErrorCause {
  if (!error || typeof error !== "object") return { name: "Error", message: String(error) };
  const raw = error as Record<string, unknown>;
  const cause: ErrorCause = { name: String(raw.name ?? "Error"), message: String(raw.message ?? "") };
  const code = pick<string>(raw.code, "string");
  if (code) cause.code = code;
  const errno = pick<number>(raw.errno, "number");
  if (errno !== undefined) cause.errno = errno;
  for (const key of ["syscall", "hostname", "address"] as const) { const value = pick<string>(raw[key], "string"); if (value) cause[key] = value; }
  const port = pick<number>(raw.port, "number");
  if (port !== undefined) cause.port = port;
  const socket = socketSnapshot(raw.socket);
  if (socket) cause.socket = socket;
  if (depth < 2 && Array.isArray(raw.errors) && raw.errors.length) cause.causes = raw.errors.slice(0, 4).map(inner => describeError(inner, depth + 1));
  return cause;
}

export function errorCause(error: unknown): ErrorCause {
  const outer = describeError(error, 0);
  const inner = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  if (!inner || typeof inner !== "object") return outer;
  const cause = describeError(inner, 0);
  if (!cause.code && cause.causes?.[0]?.code) cause.code = cause.causes[0].code;
  return { ...cause, message: cause.message ? `${outer.message}: ${cause.message}` : outer.message };
}

export const isAbort = (error: unknown) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export function answerEvidence(status: number, headers: Headers, text: string): AnswerEvidence {
  const kept: Record<string, string> = {};
  for (const name of EVIDENCE_HEADERS) { const value = headers.get(name); if (value !== null) kept[name] = value; }
  const bytes = Buffer.from(text, "utf8");
  const bodyExcerpt = bytes.length <= BODY_EXCERPT_BYTES ? text : bytes.subarray(0, BODY_EXCERPT_BYTES).toString("utf8");
  let error: string | null = null;
  let statusPageCode: string | null = null;
  try {
    const body = JSON.parse(text) as { error?: unknown; statusPage?: { code?: unknown } };
    if (typeof body.error === "string") error = body.error;
    else if (body.error && typeof body.error === "object") error = JSON.stringify(body.error).slice(0, 200);
    if (body.statusPage?.code !== undefined && body.statusPage.code !== null) statusPageCode = String(body.statusPage.code);
  } catch {
    error = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? null;
    statusPageCode = /"statusPage"\s*:\s*\{[^{}]*?"code"\s*:\s*"?([^",}\s]+)/.exec(text)?.[1] ?? null;
  }
  return { status, headers: kept, bodyExcerpt, error, statusPageCode };
}

let loopDelay: IntervalHistogram | null = null;

export function watchEventLoop(): void {
  if (loopDelay) return;
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
}

export function eventLoopDelayMaxMs(): number | null {
  return loopDelay && loopDelay.count > 0 ? Math.round(loopDelay.max / 1e6) : null;
}

export function resetEventLoopDelay(): void { loopDelay?.reset(); }

export interface ClockStart { wall: number; mono: number }
export const startClock = (): ClockStart => ({ wall: Date.now(), mono: performance.now() });

export function readClock(start: ClockStart, timeoutMs: number, aborted: boolean, probe: ProbeContext | undefined): ClientClock {
  const elapsedMs = Date.now() - start.wall;
  const monotonicMs = Math.round(performance.now() - start.mono);
  return { timeoutMs, elapsedMs, monotonicMs, timerLagMs: aborted ? elapsedMs - timeoutMs : null, clockJumpMs: elapsedMs - monotonicMs,
    loopDelayMaxMs: eventLoopDelayMaxMs(), gapBeforeMs: probe?.gapBeforeMs ?? null, intervalMs: probe?.intervalMs ?? null };
}

interface Tracked { id: string; sentAt: number | null; info: ConnectionInfo }
const emptyInfo = (): ConnectionInfo => ({ reused: null, remoteAddress: null, remotePort: null, localAddress: null, localPort: null, dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null });

class ConnectionTracker {
  private readonly byId = new Map<string, Tracked>();
  private readonly byRequest = new WeakMap<object, Tracked>();
  private readonly connectStarted = new WeakMap<object, number>();
  private readonly socketConnectMs = new WeakMap<object, number>();
  private readonly socketUses = new WeakMap<object, number>();
  private subscribed = false;

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    dc.subscribe("undici:request:create", message => {
      const request = (message as { request?: { headers?: unknown } }).request;
      const id = request ? requestIdOf(request.headers) : null;
      if (!request || !id) return;
      const tracked: Tracked = { id, sentAt: null, info: emptyInfo() };
      this.byId.set(id, tracked);
      this.byRequest.set(request, tracked);
    });
    dc.subscribe("undici:client:beforeConnect", message => {
      const params = (message as { connectParams?: object }).connectParams;
      if (params) this.connectStarted.set(params, performance.now());
    });
    dc.subscribe("undici:client:connected", message => {
      const { connectParams, socket } = message as { connectParams?: object; socket?: object };
      const started = connectParams ? this.connectStarted.get(connectParams) : undefined;
      if (socket && started !== undefined) this.socketConnectMs.set(socket, Math.round(performance.now() - started));
    });
    dc.subscribe("undici:client:sendHeaders", message => {
      const { request, socket } = message as { request?: object; socket?: Socket };
      const tracked = request ? this.byRequest.get(request) : undefined;
      if (!tracked || !socket) return;
      const uses = this.socketUses.get(socket) ?? 0;
      this.socketUses.set(socket, uses + 1);
      tracked.sentAt = performance.now();
      Object.assign(tracked.info, { reused: uses > 0, remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null,
        localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null, connectMs: uses > 0 ? null : this.socketConnectMs.get(socket) ?? null });
    });
    dc.subscribe("undici:request:headers", message => {
      const request = (message as { request?: object }).request;
      const tracked = request ? this.byRequest.get(request) : undefined;
      if (tracked?.sentAt != null) tracked.info.ttfbMs = Math.round(performance.now() - tracked.sentAt);
    });
  }

  report(id: string, info: ConnectionInfo): void { this.byId.set(id, { id, sentAt: null, info }); }

  take(id: string): ConnectionInfo | null {
    const tracked = this.byId.get(id);
    this.byId.delete(id);
    return tracked ? tracked.info : null;
  }
}

function requestIdOf(headers: unknown): string | null {
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) if (String(headers[index]).toLowerCase() === REQUEST_ID_HEADER) return String(headers[index + 1]);
    return null;
  }
  if (typeof headers === "string") return new RegExp(`${REQUEST_ID_HEADER}: ([^\\r\\n]+)`, "i").exec(headers)?.[1] ?? null;
  return null;
}

export const connections = new ConnectionTracker();
export const newRequestId = () => randomUUID();

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface PartialAnswer { status: number; headers: Headers; body: string }
export const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function partialAnswerOf(error: unknown): PartialAnswer | null {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 3; current = (current as { cause?: unknown }).cause, depth += 1) {
    const answer = (current as { answer?: PartialAnswer }).answer;
    if (answer && typeof answer.status === "number") return answer;
  }
  return null;
}

function answerHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return headers;
}

function freshHop(url: URL, init: RequestInit, headers: Record<string, string>, id: string | null): Promise<Response> {
  const client = url.protocol === "http:" ? http : https;
  const info = emptyInfo();
  info.reused = false;
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let answered: { response: http.IncomingMessage; chunks: Buffer[] } | null = null;
    const partial = (): PartialAnswer | undefined => answered ? { status: answered.response.statusCode ?? 0, headers: answerHeaders(answered.response.headers),
      body: Buffer.concat(answered.chunks).toString("utf8") } : undefined;
    const failed = (error: Error) => new TypeError("fetch failed", { cause: Object.assign(error, { answer: partial(), socket: socketSnapshot({ localAddress: info.localAddress,
      localPort: info.localPort, remoteAddress: info.remoteAddress, remotePort: info.remotePort, bytesWritten: request.socket?.bytesWritten, bytesRead: request.socket?.bytesRead }) }) });
    const finish = (outcome: () => void) => { if (settled) return; settled = true; init.signal?.removeEventListener("abort", onAbort); if (id) connections.report(id, info); outcome(); };
    const request = client.request(url, { method: init.method ?? "GET", headers, agent: false });
    const onAbort = () => {
      request.destroy();
      const reason = init.signal!.reason as Error;
      finish(() => reject(answered ? Object.assign(new Error(reason.message), { name: reason.name, answer: partial() }) : reason));
    };
    if (init.signal?.aborted) { onAbort(); return; }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("socket", socket => {
      socket.once("lookup", () => { info.dnsMs = since(); });
      socket.once("connect", () => { info.connectMs = since(); Object.assign(info, { remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null,
        localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null }); });
      socket.once("secureConnect", () => { info.tlsMs = since() - (info.connectMs ?? 0); });
    });
    request.on("response", response => {
      info.ttfbMs = since();
      answered = { response, chunks: [] };
      const status = response.statusCode ?? 0;
      const limit = status >= 200 && status < 300 ? Number.POSITIVE_INFINITY : ERROR_BODY_READ_BYTES;
      let kept = 0;
      const complete = () => finish(() => resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(answered!.chunks),
        { status, statusText: response.statusMessage, headers: answerHeaders(response.headers) })));
      response.on("data", (chunk: Buffer) => {
        const piece = chunk.subarray(0, Math.min(chunk.length, limit - kept));
        kept += piece.length;
        answered!.chunks.push(Buffer.from(piece));
        if (kept >= limit) {
          complete();
          request.destroy();
        }
      });
      response.on("error", error => finish(() => reject(failed(error))));
      response.on("aborted", () => finish(() => reject(failed(Object.assign(new Error("the answer was cut short"), { code: "ECONNRESET" })))));
      response.on("end", complete);
    });
    request.on("error", error => finish(() => reject(failed(error))));
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}

export const freshConnectionFetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const origin = new URL(input instanceof Request ? input.url : String(input));
  const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers).entries()), connection: "close" };
  const id = headers[REQUEST_ID_HEADER] ?? null;
  let url = origin;
  let hopInit = init;
  for (let hop = 0; ; hop += 1) {
    const response = await freshHop(url, hopInit, headers, id);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location || hop >= MAX_REDIRECTS || init.redirect === "manual") return response;
    const next = new URL(location, url);
    if (next.origin !== origin.origin) return response;
    url = next;
    if (response.status === 303) hopInit = { ...hopInit, method: "GET", body: undefined };
  }
}) as typeof fetch;

export async function followUp(fetcher: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<FollowUp> {
  const id = newRequestId();
  const started = Date.now();
  const outcome = (fields: Pick<FollowUp, "ok" | "status" | "error">): FollowUp => ({ url, ...fields, ms: Date.now() - started,
    remoteAddress: connections.take(id)?.remoteAddress ?? null });
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { ...headers, [REQUEST_ID_HEADER]: id } });
  } catch (error) {
    return outcome({ ok: false, status: partialAnswerOf(error)?.status ?? null, error: errorCause(error) });
  }
  try {
    await response.arrayBuffer();
  } catch (error) {
    return outcome({ ok: false, status: response.status, error: errorCause(error) });
  }
  return outcome({ ok: response.ok, status: response.status, error: null });
}

export function clientStall(clock: ClientClock): string | null {
  if (clock.timerLagMs !== null && clock.timerLagMs > STALL_MS) return `the ${clock.timeoutMs} ms abort fired after ${clock.elapsedMs} ms (${clock.timerLagMs} ms late)`;
  if (Math.abs(clock.clockJumpMs) > STALL_MS) return `the wall clock moved ${clock.clockJumpMs} ms more than the monotonic clock`;
  if (clock.loopDelayMaxMs !== null && clock.loopDelayMaxMs > STALL_MS) return `the event loop was blocked for up to ${clock.loopDelayMaxMs} ms`;
  if (clock.gapBeforeMs !== null && clock.intervalMs !== null && clock.gapBeforeMs > 2 * clock.intervalMs)
    return `the probe loop paused ${clock.gapBeforeMs} ms before this probe (interval ${clock.intervalMs} ms)`;
  return null;
}

const followUpText = (name: string, outcome: FollowUp | null) => outcome === null ? `${name} not run`
  : outcome.ok ? `${name} ok ${outcome.status} in ${outcome.ms} ms`
    : `${name} failed ${outcome.status ?? outcome.error?.code ?? outcome.error?.name ?? "?"} in ${outcome.ms} ms`;

export function classifyFailure(diagnosis: FailureDiagnosis | null | undefined): Classified {
  if (!diagnosis) return { class: "unclassified", reason: "no diagnosis recorded" };
  const answered = diagnosis.answer?.status ?? null;
  const success = answered !== null && answered >= 200 && answered < 300;
  if (answered !== null && !success) return { class: "server", reason: `HTTP ${answered}` };
  if (success && !diagnosis.cause) return { class: "server", reason: `HTTP ${answered} with an unreadable body` };
  const stall = clientStall(diagnosis.clock);
  if (stall) return { class: "client", reason: `client_stall: ${stall}` };
  const { control, retry } = diagnosis;
  const code = diagnosis.cause?.code ?? null;
  if (control && !control.ok) return diagnosis.controlReachedThisRun
    ? { class: "client", reason: `the control probe to the neutral endpoint failed too (${followUpText("control", control)})` }
    : { class: "unclassified", reason: `the control probe failed and the neutral endpoint has not answered once in this run (${followUpText("control", control)})` };
  if (code && DNS_CODES.has(code)) {
    if (code !== "ENOTFOUND") return { class: "client", reason: `client DNS failure (${code})` };
    if (retry && retry.error?.code !== "ENOTFOUND") return { class: "client", reason: "client DNS failure (ENOTFOUND, the immediate retry resolved the host)" };
  }
  if (!control) return { class: "unclassified", reason: `${code ?? (diagnosis.aborted ? "timeout" : diagnosis.cause?.message ?? "failure")} without a control probe` };
  if (code && RESET_CODES.has(code)) return { class: "server", reason: `connection reset (${code}) while the control probe succeeded` };
  if (code && REFUSED_CODES.has(code)) return { class: "server", reason: `connection refused (${code}) while the control probe succeeded` };
  if (diagnosis.aborted || (code && TIMEOUT_CODES.has(code))) return { class: "server", reason: `timeout (${code ?? "abort"}) while the control probe succeeded and the client did not stall` };
  return { class: "unclassified", reason: `${code ?? diagnosis.cause?.message ?? "unknown failure"} with the control probe ok` };
}

export function failureEvidence(diagnosis: FailureDiagnosis | null | undefined): string {
  if (!diagnosis) return "no diagnosis recorded";
  const parts: string[] = [];
  if (diagnosis.answer) {
    const { answer } = diagnosis;
    parts.push(`status ${answer.status}`);
    const headers = Object.entries(answer.headers).filter(([name]) => name !== "date" && name !== "content-type").map(([name, value]) => `${name}=${value}`);
    if (headers.length) parts.push(headers.join(" "));
    if (answer.error) parts.push(`error "${answer.error}"`);
    if (answer.statusPageCode) parts.push(`statusPage.code ${answer.statusPageCode}`);
    if (answer.bodyExcerpt && !answer.error) parts.push(`body "${answer.bodyExcerpt.slice(0, 120).replace(/\s+/g, " ")}"`);
  }
  if (diagnosis.cause) {
    const { cause } = diagnosis;
    const where = cause.address ? ` ${cause.address}${cause.port ? `:${cause.port}` : ""}` : cause.hostname ? ` ${cause.hostname}` : "";
    parts.push(`${cause.code ?? cause.name}${cause.syscall ? ` ${cause.syscall}` : ""}${where}`);
    if (cause.socket) parts.push(`socket ${cause.socket.localAddress ?? "?"}:${cause.socket.localPort ?? "?"} -> ${cause.socket.remoteAddress ?? "?"}:${cause.socket.remotePort ?? "?"}`
      + `${cause.socket.bytesWritten !== undefined ? ` wrote ${cause.socket.bytesWritten} B` : ""}${cause.socket.bytesRead !== undefined ? ` read ${cause.socket.bytesRead} B` : ""}`);
  }
  if (diagnosis.connection) {
    const { connection } = diagnosis;
    parts.push(`${connection.reused === null ? "socket ?" : connection.reused ? "reused socket" : "new socket"}${connection.remoteAddress ? ` to ${connection.remoteAddress}` : ""}`);
  }
  const { clock } = diagnosis;
  parts.push(`${clock.elapsedMs} ms of ${clock.timeoutMs} ms`);
  if (clock.timerLagMs !== null) parts.push(`timer lag ${clock.timerLagMs} ms`);
  if (clock.clockJumpMs) parts.push(`clock jump ${clock.clockJumpMs} ms`);
  if (clock.loopDelayMaxMs !== null) parts.push(`loop delay max ${clock.loopDelayMaxMs} ms`);
  if (clock.gapBeforeMs !== null) parts.push(`gap before ${clock.gapBeforeMs} ms`);
  parts.push(followUpText("control", diagnosis.control), followUpText("retry", diagnosis.retry));
  return parts.join("; ");
}

export interface ClassifiedFailure extends Classified { at: number; evidence: string }
export interface FailureClassSummary { client: number; server: number; unclassified: number; failures: ClassifiedFailure[] }

export function summarizeFailures(entries: ReadonlyArray<{ at: number; ok: boolean; failure?: FailureRecord | null }>): FailureClassSummary {
  const classOf = (failure: FailureRecord | null | undefined): Classified => !failure ? { class: "unclassified", reason: "no diagnosis recorded" }
    : failure.state === "settled" ? { class: failure.class, reason: failure.reason }
      : { class: "unclassified", reason: "diagnosis did not finish before the grade" };
  const failures = entries.filter(entry => !entry.ok).map((entry): ClassifiedFailure => ({ at: entry.at, ...classOf(entry.failure), evidence: failureEvidence(entry.failure) }));
  return { client: failures.filter(entry => entry.class === "client").length, server: failures.filter(entry => entry.class === "server").length,
    unclassified: failures.filter(entry => entry.class === "unclassified").length, failures };
}

const CLASS_LABEL: Record<FailureClass, string> = { client: "client-side (informational)", server: "server-side", unclassified: "unclassified" };

export function failureLines(title: string, summary: FailureClassSummary, limit = 200): string[] {
  if (!summary.failures.length) return [];
  return [`${title}: ${summary.server} server-side, ${summary.unclassified} unclassified, ${summary.client} client-side (informational, not counted by gate D).`,
    ...summary.failures.slice(0, limit).map(entry => `- ${new Date(entry.at).toISOString()} ${CLASS_LABEL[entry.class]}: ${entry.reason}. Evidence: ${entry.evidence}.`),
    ...(summary.failures.length > limit ? [`- … ${summary.failures.length - limit} more in health.jsonl`] : [])];
}
