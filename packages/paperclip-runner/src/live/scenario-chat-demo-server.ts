import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import { CapabilityChatSession } from "../scenarios/chat-session.js";
import { buildCapabilityScenarioIndex } from "../scenarios/scenario-index.js";
import { capabilityScenarioFixture } from "../scenarios/scenario-fixtures.js";
import type {
  CapabilityChatSessionArtifact,
  CapabilityScenarioIndex,
  CapabilityScenarioIndexEntry,
} from "../scenarios/scenario-explorer-types.js";

const REQUEST_BODY_BYTES = 64 * 1024;
const PROMPT_BYTES = 16 * 1024;
const MAX_ACTIVE_SESSIONS = 8;
const SESSION_IDLE_MS = 5 * 60_000;
const SESSION_LIFETIME_MS = 30 * 60_000;
const MAX_SESSION_EVENTS = 1_024;
const MAX_SERIALIZED_STATE_BYTES = 1024 * 1024;
const TURN_DEADLINE_MS = 30_000;
const SECURE_CAPABILITY_COOKIE = "__Host-paperclip_scenario-chat";
const TAILNET_HTTP_CAPABILITY_COOKIE = "paperclip_scenario-chat";

const FORBIDDEN_ENV_NAME = /^(?:PAPERCLIP_|GITHUB_|AWS_|GOOGLE_|AZURE_)|(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|CODEX_HOME)$/i;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type SessionRecord = {
  id: string;
  capabilityHash: Buffer;
  identityHash: string;
  createdAt: number;
  lastActiveAt: number;
  activeTurn: boolean;
  chat: CapabilityChatSession;
};

type RuntimeOptions = {
  publicOrigin: string;
  basePath: string;
  commitSha: string;
  allowInsecureHttp?: boolean;
  packageRoot?: string;
  now?: () => number;
  log?: (record: Record<string, unknown>) => void;
};

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function shortHash(value: string): string {
  return sha256(value).toString("hex").slice(0, 16);
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function requestIdentity(req: IncomingMessage): string {
  const login = header(req, "tailscale-user-login").trim();
  if (login) return `tailnet:${login.toLowerCase()}`;
  const forwardedFor = header(req, "x-forwarded-for").split(",")[0]?.trim();
  return `tailnet-peer:${forwardedFor || "serve-proxy"}`;
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of header(req, "cookie").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return result;
}

function capabilityCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAgeSeconds = 1_800,
): string {
  const secureAttribute = secure ? "; Secure" : "";
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secureAttribute}; SameSite=Strict`;
}

export function scenarioChatCapabilityCookieForOrigin(
  publicOrigin: URL,
  value: string,
  maxAgeSeconds = 1_800,
): string {
  const secure = publicOrigin.protocol === "https:";
  return capabilityCookie(
    secure ? SECURE_CAPABILITY_COOKIE : TAILNET_HTTP_CAPABILITY_COOKIE,
    value,
    secure,
    maxAgeSeconds,
  );
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  applySecurityHeaders(res);
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(res: ServerResponse, error: RequestFailure): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const mediaType = header(req, "content-type").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestFailure(415, "json_required", "Mutation requests require application/json.");
  }
  const declaredLength = Number(header(req, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_BYTES) {
    throw new RequestFailure(413, "request_too_large", "Request body exceeds the 64 KiB limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > REQUEST_BODY_BYTES) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    throw new RequestFailure(413, "request_too_large", "Request body exceeds the 64 KiB limit.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestFailure(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(body).find((key) => !expectedSet.has(key));
  if (unknown) {
    throw new RequestFailure(422, "unexpected_field", "Request contains an unsupported field.");
  }
}

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RequestFailure(504, "turn_timeout", "The turn exceeded its 30 second deadline.")),
        TURN_DEADLINE_MS,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function assertArtifactBounds(artifact: CapabilityChatSessionArtifact): void {
  if (artifact.timeline.length > MAX_SESSION_EVENTS) {
    throw new RequestFailure(507, "event_limit", "The session exceeded its retained event limit.");
  }
  if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_SERIALIZED_STATE_BYTES) {
    throw new RequestFailure(507, "state_limit", "The session exceeded its serialized state limit.");
  }
}

export function forbiddenScenarioChatEnvironmentNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => FORBIDDEN_ENV_NAME.test(name)).sort();
}

export function assertScenarioChatEnvironmentSafe(env: NodeJS.ProcessEnv): void {
  const forbidden = forbiddenScenarioChatEnvironmentNames(env);
  if (forbidden.length > 0) {
    throw new Error(`Scenario chat refused forbidden environment names: ${forbidden.join(", ")}`);
  }
}

export class ScenarioChatDemoRuntime {
  readonly publicOrigin: URL;
  readonly basePath: string;
  readonly commitSha: string;

  private readonly secureTransport: boolean;
  private readonly capabilityCookieName: string;
  private readonly packageRoot: string;
  private readonly staticRoot: string;
  private readonly now: () => number;
  private readonly logRecord: (record: Record<string, unknown>) => void;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly rateBuckets = new Map<string, number[]>();
  private scenarioIndex: CapabilityScenarioIndex | null = null;
  private ready = false;
  private closing = false;

  constructor(options: RuntimeOptions) {
    this.publicOrigin = new URL(options.publicOrigin);
    this.secureTransport = this.publicOrigin.protocol === "https:";
    if (
      !this.secureTransport
      && !(this.publicOrigin.protocol === "http:" && options.allowInsecureHttp === true)
    ) {
      throw new Error("SCENARIO_CHAT_PUBLIC_ORIGIN must use HTTPS unless tailnet HTTP is explicitly enabled");
    }
    this.capabilityCookieName = this.secureTransport
      ? SECURE_CAPABILITY_COOKIE
      : TAILNET_HTTP_CAPABILITY_COOKIE;
    this.basePath = normalizeBasePath(options.basePath);
    this.commitSha = options.commitSha.trim() || "unknown";
    this.packageRoot = options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    this.staticRoot = resolve(this.packageRoot, "dist-scenarios");
    this.now = options.now ?? Date.now;
    this.logRecord = options.log ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  }

  async initialize(): Promise<void> {
    const manifest = await readFile(
      resolve(this.packageRoot, "spec/capability/eval-traceability.yaml"),
      "utf8",
    );
    this.scenarioIndex = buildCapabilityScenarioIndex(manifest);
    const probe = this.scenarioIndex.entries[0];
    if (!probe) throw new Error("Capability scenario corpus is empty");
    const chat = await this.openConcreteMockSession(probe);
    await chat.close();
    this.ready = true;
  }

  createServer(): Server {
    const server = createServer((req, res) => void this.handle(req, res));
    server.maxConnections = 32;
    server.requestTimeout = 35_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    return server;
  }

  health(): Record<string, unknown> {
    return {
      status: this.ready && !this.closing ? "ok" : "unavailable",
      ready: this.ready && !this.closing && this.sessions.size < MAX_ACTIVE_SESSIONS,
      commitSha: this.commitSha,
      controlPlane: "capability-mock",
      providerAuthentication: "server-side",
      providerMode: "deterministic-scripted-no-provider",
      credentialsExposed: false,
      networkEgress: "denied",
      retention: "memory-only",
      activeSessions: this.sessions.size,
      limits: {
        requestBodyBytes: REQUEST_BODY_BYTES,
        promptBytes: PROMPT_BYTES,
        activeSessions: MAX_ACTIVE_SESSIONS,
        activeTurnsPerSession: 1,
        turnDeadlineSeconds: TURN_DEADLINE_MS / 1_000,
        idleExpirySeconds: SESSION_IDLE_MS / 1_000,
        absoluteLifetimeSeconds: SESSION_LIFETIME_MS / 1_000,
        retainedEventsPerSession: MAX_SESSION_EVENTS,
        serializedStateBytesPerSession: MAX_SERIALIZED_STATE_BYTES,
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(records.map((record) => record.chat.close()));
    this.ready = false;
  }

  async expireSessions(): Promise<number> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter(
      (record) => now - record.lastActiveAt >= SESSION_IDLE_MS || now - record.createdAt >= SESSION_LIFETIME_MS,
    );
    for (const record of expired) this.sessions.delete(record.id);
    await Promise.allSettled(expired.map((record) => record.chat.close()));
    return expired.length;
  }

  private async openConcreteMockSession(entry: CapabilityScenarioIndexEntry): Promise<CapabilityChatSession> {
    const fixture = capabilityScenarioFixture(entry);
    // The concrete adapter choice is fixed here. No request or environment
    // value can supply a module, URL, path, or alternate control plane.
    const adapter = new CapabilityMockControlPlaneAdapter(fixture.seed);
    return await CapabilityChatSession.openWithMockAdapter(entry, adapter, { mode: "fake" });
  }

  private stripBasePath(rawPath: string): string {
    if (this.basePath && rawPath === this.basePath) return "/";
    if (this.basePath && rawPath.startsWith(`${this.basePath}/`)) {
      return rawPath.slice(this.basePath.length) || "/";
    }
    return rawPath;
  }

  private assertProxyAdmission(req: IncomingMessage): void {
    if (header(req, "x-scenario-chat-proxy") !== "v1") {
      throw new RequestFailure(403, "trusted_proxy_required", "Request did not arrive through the trusted proxy.");
    }
    const forwardedProtocol = header(req, "x-forwarded-proto").toLowerCase();
    if (forwardedProtocol !== this.publicOrigin.protocol.slice(0, -1)) {
      throw new RequestFailure(403, "transport_denied", "Forwarded transport is not allowed.");
    }
    const forwardedHost = header(req, "x-forwarded-host").toLowerCase();
    if (forwardedHost !== this.publicOrigin.host.toLowerCase()) {
      throw new RequestFailure(403, "host_denied", "Forwarded host is not allowed.");
    }
  }

  private assertMutationAdmission(req: IncomingMessage): void {
    this.assertProxyAdmission(req);
    if (header(req, "origin") !== this.publicOrigin.origin) {
      throw new RequestFailure(403, "origin_denied", "Request origin is not allowed.");
    }
    if (
      header(req, "sec-fetch-site").toLowerCase() !== "same-origin" ||
      header(req, "sec-fetch-mode").toLowerCase() !== "cors" ||
      header(req, "sec-fetch-dest").toLowerCase() !== "empty"
    ) {
      throw new RequestFailure(403, "fetch_metadata_denied", "Mutation request metadata is not allowed.");
    }
  }

  private enforceRate(key: string, limit: number, windowMs = 60_000): void {
    const now = this.now();
    const bucket = (this.rateBuckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (bucket.length >= limit) {
      throw new RequestFailure(429, "rate_limited", "Request rate limit exceeded.");
    }
    bucket.push(now);
    this.rateBuckets.set(key, bucket);
  }

  private requireSession(req: IncomingMessage, id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new RequestFailure(404, "session_not_found", "Session was not found.");
    const capability = parseCookies(req).get(this.capabilityCookieName) ?? "";
    const capabilityHash = sha256(capability);
    const identityHash = shortHash(requestIdentity(req));
    if (
      capability.length < 32 ||
      capabilityHash.length !== record.capabilityHash.length ||
      !timingSafeEqual(capabilityHash, record.capabilityHash) ||
      identityHash !== record.identityHash
    ) {
      throw new RequestFailure(404, "session_not_found", "Session was not found.");
    }
    const now = this.now();
    if (now - record.lastActiveAt >= SESSION_IDLE_MS || now - record.createdAt >= SESSION_LIFETIME_MS) {
      this.sessions.delete(record.id);
      void record.chat.close();
      throw new RequestFailure(404, "session_not_found", "Session was not found.");
    }
    record.lastActiveAt = now;
    return record;
  }

  private async createSession(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    exactKeys(body, ["scenarioId"]);
    const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : "";
    const entry = this.scenarioIndex?.entries.find((candidate) => candidate.id === scenarioId);
    if (!entry) throw new RequestFailure(422, "scenario_unknown", "Scenario is not available.");
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new RequestFailure(429, "session_capacity", "The active session limit has been reached.");
    }
    const identityHash = shortHash(requestIdentity(req));
    this.enforceRate("global:create", 40);
    this.enforceRate(`${identityHash}:create`, 10);
    const capability = randomBytes(32).toString("base64url");
    const chat = await this.openConcreteMockSession(entry);
    const artifact = chat.artifact();
    assertArtifactBounds(artifact);
    const now = this.now();
    const record: SessionRecord = {
      id: randomBytes(16).toString("hex"),
      capabilityHash: sha256(capability),
      identityHash,
      createdAt: now,
      lastActiveAt: now,
      activeTurn: false,
      chat,
    };
    this.sessions.set(record.id, record);
    res.setHeader(
      "Set-Cookie",
      scenarioChatCapabilityCookieForOrigin(this.publicOrigin, capability),
    );
    sendJson(res, 201, { sessionId: record.id, artifact, nextPrompt: chat.nextPrompt() });
  }

  private async runTurn(
    req: IncomingMessage,
    res: ServerResponse,
    record: SessionRecord,
    body: Record<string, unknown>,
  ): Promise<void> {
    exactKeys(body, ["prompt"]);
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new RequestFailure(422, "prompt_required", "Prompt must be a non-empty string.");
    }
    const prompt = body.prompt.trim();
    if (Buffer.byteLength(prompt, "utf8") > PROMPT_BYTES) {
      throw new RequestFailure(422, "prompt_too_large", "Prompt exceeds the 16 KiB limit.");
    }
    if (record.activeTurn) throw new RequestFailure(409, "turn_active", "A turn is already active.");
    this.enforceRate("global:turn", 120);
    this.enforceRate(`${record.identityHash}:turn`, 30);
    record.activeTurn = true;
    try {
      const artifact = await withDeadline(record.chat.send(prompt));
      assertArtifactBounds(artifact);
      sendJson(res, 200, { sessionId: record.id, artifact, nextPrompt: record.chat.nextPrompt() });
    } catch (error) {
      if (error instanceof RequestFailure && error.code === "turn_timeout") {
        this.sessions.delete(record.id);
        await record.chat.close();
      }
      throw error;
    } finally {
      record.activeTurn = false;
    }
  }

  private async replaySession(res: ServerResponse, record: SessionRecord): Promise<void> {
    if (record.activeTurn) throw new RequestFailure(409, "turn_active", "A turn is already active.");
    this.enforceRate("global:turn", 120);
    this.enforceRate(`${record.identityHash}:turn`, 30);
    record.activeTurn = true;
    try {
      const artifact = await withDeadline(record.chat.replay());
      assertArtifactBounds(artifact);
      sendJson(res, 200, { sessionId: record.id, artifact, nextPrompt: record.chat.nextPrompt() });
    } finally {
      record.activeTurn = false;
    }
  }

  private async resetSession(req: IncomingMessage, res: ServerResponse, record: SessionRecord): Promise<void> {
    this.enforceRate(`${record.identityHash}:reset`, 10);
    this.sessions.delete(record.id);
    const entry = record.chat.entry;
    await record.chat.close();
    const capability = randomBytes(32).toString("base64url");
    const chat = await this.openConcreteMockSession(entry);
    const artifact = chat.artifact();
    assertArtifactBounds(artifact);
    const now = this.now();
    const replacement: SessionRecord = {
      id: randomBytes(16).toString("hex"),
      capabilityHash: sha256(capability),
      identityHash: record.identityHash,
      createdAt: now,
      lastActiveAt: now,
      activeTurn: false,
      chat,
    };
    this.sessions.set(replacement.id, replacement);
    res.setHeader(
      "Set-Cookie",
      scenarioChatCapabilityCookieForOrigin(this.publicOrigin, capability),
    );
    sendJson(res, 200, { sessionId: replacement.id, artifact, nextPrompt: chat.nextPrompt() });
  }

  private async deleteSession(res: ServerResponse, record: SessionRecord): Promise<void> {
    this.sessions.delete(record.id);
    await record.chat.close();
    res.setHeader(
      "Set-Cookie",
      scenarioChatCapabilityCookieForOrigin(this.publicOrigin, "deleted", 0),
    );
    sendJson(res, 200, { closed: true });
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    this.assertProxyAdmission(req);
    if (req.method !== "GET" && req.method !== "HEAD") {
      throw new RequestFailure(405, "method_not_allowed", "Method is not allowed.");
    }
    const decoded = decodeURIComponent(pathname);
    const relativePath = decoded === "/" ? "scenario-explorer/index.html" : decoded.replace(/^\/+/, "");
    const filePath = resolve(this.staticRoot, relativePath);
    const relativeToRoot = relative(this.staticRoot, filePath);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      throw new RequestFailure(404, "not_found", "Resource was not found.");
    }
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      throw new RequestFailure(404, "not_found", "Resource was not found.");
    }
    if (relativePath === "scenario-explorer/index.html") {
      const html = body.toString("utf8").replace(
        "</head>",
        '<meta name="scenario-chat-api-base" content="api/capability" /></head>',
      );
      body = Buffer.from(html);
    }
    applySecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", body.length);
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = this.now();
    const requestId = randomBytes(8).toString("hex");
    let route = "unknown";
    let outcome = "error";
    try {
      if (this.closing) throw new RequestFailure(503, "shutting_down", "Service is shutting down.");
      const url = new URL(req.url ?? "/", "http://scenario-chat.invalid");
      const pathname = this.stripBasePath(url.pathname);
      if (pathname === "/api/capability/health" && req.method === "GET") {
        route = "health";
        this.assertProxyAdmission(req);
        sendJson(res, this.ready ? 200 : 503, this.health());
        outcome = "ok";
        return;
      }
      if (pathname.startsWith("/api/capability/")) {
        this.assertMutationAdmission(req);
        const identityHash = shortHash(requestIdentity(req));
        this.enforceRate("global:request", 300);
        this.enforceRate(`${identityHash}:request`, 90);
        if (pathname === "/api/capability/sessions" && req.method === "POST") {
          route = "session_create";
          await this.createSession(req, res, await readJsonBody(req));
          outcome = "created";
          return;
        }
        const match = pathname.match(/^\/api\/capability\/sessions\/([a-f0-9]{32})(?:\/(turn|replay|reset))?$/);
        if (!match) throw new RequestFailure(404, "not_found", "Route was not found.");
        const record = this.requireSession(req, match[1]!);
        const action = match[2] ?? "session";
        route = action;
        if (action === "turn" && req.method === "POST") {
          await this.runTurn(req, res, record, await readJsonBody(req));
          outcome = "settled";
          return;
        }
        if (action === "replay" && req.method === "POST") {
          exactKeys(await readJsonBody(req), []);
          await this.replaySession(res, record);
          outcome = "settled";
          return;
        }
        if (action === "reset" && req.method === "POST") {
          exactKeys(await readJsonBody(req), []);
          await this.resetSession(req, res, record);
          outcome = "reset";
          return;
        }
        if (action === "session" && req.method === "DELETE") {
          await this.deleteSession(res, record);
          outcome = "closed";
          return;
        }
        throw new RequestFailure(405, "method_not_allowed", "Method is not allowed.");
      }
      route = "static";
      await this.serveStatic(req, res, pathname);
      outcome = "ok";
    } catch (error) {
      const failure = error instanceof RequestFailure
        ? error
        : new RequestFailure(500, "internal_error", "The request could not be completed.");
      if (!res.headersSent) sendError(res, failure);
      outcome = failure.code;
    } finally {
      this.logRecord({
        timestamp: new Date().toISOString(),
        requestId,
        route,
        method: req.method ?? "UNKNOWN",
        status: res.statusCode,
        outcome,
        latencyMs: Math.max(0, this.now() - startedAt),
        identity: shortHash(requestIdentity(req)),
      });
    }
  }
}

async function main(): Promise<void> {
  assertScenarioChatEnvironmentSafe(process.env);
  const socketPath = process.env.SCENARIO_CHAT_SOCKET_PATH?.trim();
  const publicOrigin = process.env.SCENARIO_CHAT_PUBLIC_ORIGIN?.trim();
  if (!socketPath || !isAbsolute(socketPath)) throw new Error("SCENARIO_CHAT_SOCKET_PATH must be absolute");
  if (!publicOrigin) throw new Error("SCENARIO_CHAT_PUBLIC_ORIGIN is required");
  const runtime = new ScenarioChatDemoRuntime({
    publicOrigin,
    basePath: process.env.SCENARIO_CHAT_BASE_PATH ?? "",
    commitSha: process.env.SCENARIO_CHAT_COMMIT_SHA ?? "unknown",
    allowInsecureHttp: process.env.SCENARIO_CHAT_ALLOW_INSECURE_HTTP === "1",
  });
  await runtime.initialize();
  const server = runtime.createServer();
  const expiryTimer = setInterval(() => void runtime.expireSessions(), 30_000);
  expiryTimer.unref();

  const stop = async (signal: string): Promise<void> => {
    clearInterval(expiryTimer);
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: "shutdown", signal })}\n`);
    server.close();
    await runtime.shutdown();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "ready",
    controlPlane: "capability-mock",
    commitSha: runtime.commitSha,
    networkEgress: "denied",
  })}\n`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "startup_failed",
      code:
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : "Error",
    })}\n`);
    process.exitCode = 1;
  });
}
