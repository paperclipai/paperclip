import { readFile } from "node:fs/promises";

export interface ServerGbrainClientOptions {
  url?: string;
  /**
   * If set, the client always sends this bearer verbatim. Overrides the
   * file-mint path. Pre-existing knob for tests and emergency overrides.
   */
  bearerToken?: string;
  /**
   * Override the bearer source entirely (advanced; used by tests).
   */
  bearerSource?: BearerSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ServerGbrainClient {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

export class ServerGbrainCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ServerGbrainCallError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?:
    | {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      }
    | unknown;
  error?: { code: number; message: string };
}

const DEFAULT_GBRAIN_MCP_URL = "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp";
const DEFAULT_GBRAIN_TOKEN_URL = "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/token";
const DEFAULT_GBRAIN_CLIENTS_FILE = "/etc/paperclip-plugin-gbrain/clients.json";

// Blockcast CEO agent UUID — the same client identity the StatefulSet `seed`
// init container mints under for the baseline /paperclip/.mcp.json gbrain
// entry. Reusing it for the server-side preflight gate keeps the OAuth-side
// surface area unchanged: every agent's client has the same /mcp scope, so
// picking one is operationally neutral. Overridable via the
// PAPERCLIP_GBRAIN_OAUTH_AGENT_ID env var when a deployment doesn't have
// this UUID (e.g. multi-tenant brain instances).
const DEFAULT_BLOCKCAST_CEO_AGENT_ID = "4eca1725-632f-45fa-97a2-8cf7e0430958";

// Refresh tokens this far before their stated expiry. The admin-ui issues
// 24h tokens by default; refreshing 1h early gives us plenty of headroom
// against clock skew and request latency.
const DEFAULT_REFRESH_LEAD_MS = 60 * 60 * 1000;

function parseMcpResponseBody(text: string): JsonRpcResponse {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
  }
  throw new Error(`unexpected MCP response body: ${text.slice(0, 120)}`);
}

/**
 * Bearer-token resolution strategy for the server-side gbrain client. Three
 * concrete implementations cover the three deployment shapes:
 *
 *  - `StaticBearer`     — static value (env var, test injection).
 *  - `NullBearer`       — no bearer at all; gate will fail-open on 401.
 *  - `OAuthMintBearer`  — production path. Reads a per-agent client_id /
 *                          client_secret from a mounted clients.json file
 *                          and exchanges them at the admin-ui's /token
 *                          endpoint via the OAuth client_credentials grant.
 *                          Token is cached until 1h before expiry.
 *
 * All implementations return `undefined` on any failure. The
 * `HttpServerGbrainClient` treats undefined as "send no Authorization
 * header", which the auth-proxy rejects with 401 — the preflight gate
 * catches this and fail-opens to the normal wake path. So a misconfigured
 * bearer source never silently drops sweep wakes.
 */
export interface BearerSource {
  getBearer(): Promise<string | undefined>;
}

export class StaticBearer implements BearerSource {
  constructor(private readonly token: string) {}
  async getBearer() {
    return this.token;
  }
}

export class NullBearer implements BearerSource {
  async getBearer() {
    return undefined;
  }
}

interface OAuthMintBearerOpts {
  clientsFilePath: string;
  agentId: string;
  tokenUrl: string;
  fetch: typeof fetch;
  /** Refresh this many ms before stated expiry. Defaults to 1h. */
  refreshLeadMs?: number;
  /** File reader override (tests). Defaults to fs/promises readFile. */
  readClientsFile?: (path: string) => Promise<string>;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface ClientsFile {
  [agentId: string]: { client_id?: string; client_secret?: string; name?: string };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

export class OAuthMintBearer implements BearerSource {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string | undefined>;

  constructor(private readonly opts: OAuthMintBearerOpts) {}

  async getBearer(): Promise<string | undefined> {
    const now = this.opts.now?.() ?? Date.now();
    const refreshLeadMs = this.opts.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
    if (this.cached && this.cached.expiresAt > now + refreshLeadMs) {
      return this.cached.token;
    }
    // Coalesce concurrent refresh attempts onto a single in-flight mint.
    // Without this, a burst of preflight calls right after expiry would
    // each open their own connection to /token. The admin-ui handles it,
    // but it's wasteful and noisier in the audit log.
    if (this.inflight) return this.inflight;
    this.inflight = this.mint(now).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async mint(now: number): Promise<string | undefined> {
    const reader = this.opts.readClientsFile ?? ((p: string) => readFile(p, "utf8"));
    let clients: ClientsFile;
    try {
      const raw = await reader(this.opts.clientsFilePath);
      clients = JSON.parse(raw) as ClientsFile;
    } catch {
      // File missing / unreadable / not JSON. Caller will fail-open.
      return undefined;
    }
    const entry = clients[this.opts.agentId];
    if (!entry?.client_id || !entry?.client_secret) return undefined;

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    params.set("client_id", entry.client_id);
    params.set("client_secret", entry.client_secret);

    let resp: Response;
    try {
      resp = await this.opts.fetch(this.opts.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch {
      return undefined;
    }
    if (!resp.ok) return undefined;

    let json: TokenResponse;
    try {
      json = (await resp.json()) as TokenResponse;
    } catch {
      return undefined;
    }
    if (!json.access_token) return undefined;

    const expiresInMs = (json.expires_in ?? 86400) * 1000;
    this.cached = { token: json.access_token, expiresAt: now + expiresInMs };
    return json.access_token;
  }
}

class HttpServerGbrainClient implements ServerGbrainClient {
  private nextId = 1;

  constructor(
    private readonly opts: {
      url: string;
      bearerSource: BearerSource;
      fetch: typeof fetch;
      timeoutMs: number;
    },
  ) {}

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const bearer = await this.opts.bearerSource.getBearer();
      if (bearer) headers.authorization = `Bearer ${bearer}`;

      const resp = await this.opts.fetch(this.opts.url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      });
      if (!resp.ok) throw new ServerGbrainCallError(`HTTP ${resp.status} from ${this.opts.url}`);
      const json = parseMcpResponseBody(await resp.text());
      if (json.error) throw new ServerGbrainCallError(`JSON-RPC error ${json.error.code}: ${json.error.message}`);

      const result = json.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
      if (result?.isError === true) return null as T;
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string") return result as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    } catch (err) {
      if (err instanceof ServerGbrainCallError) throw err;
      throw new ServerGbrainCallError(err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolve the bearer source from explicit opts + env vars + the mounted
 * clients.json file, in precedence order:
 *
 *  1. `opts.bearerSource`            — test/caller-supplied
 *  2. `opts.bearerToken`             — caller-supplied static value
 *  3. `PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN` env — static override
 *  4. `clients.json` mint            — production path; reads
 *     `PAPERCLIP_GBRAIN_OAUTH_CLIENTS_FILE` (default
 *     `/etc/paperclip-plugin-gbrain/clients.json`),
 *     `PAPERCLIP_GBRAIN_OAUTH_AGENT_ID` (default Blockcast CEO),
 *     `PAPERCLIP_GBRAIN_MCP_TOKEN_URL` (default admin-ui :3130/token).
 *
 * Exposed for tests; production callers use `createServerGbrainClient`.
 */
export function resolveBearerSource(opts: ServerGbrainClientOptions = {}): BearerSource {
  if (opts.bearerSource) return opts.bearerSource;
  const explicit = opts.bearerToken ?? process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN;
  if (explicit) return new StaticBearer(explicit);
  return new OAuthMintBearer({
    clientsFilePath: process.env.PAPERCLIP_GBRAIN_OAUTH_CLIENTS_FILE ?? DEFAULT_GBRAIN_CLIENTS_FILE,
    agentId: process.env.PAPERCLIP_GBRAIN_OAUTH_AGENT_ID ?? DEFAULT_BLOCKCAST_CEO_AGENT_ID,
    tokenUrl: process.env.PAPERCLIP_GBRAIN_MCP_TOKEN_URL ?? DEFAULT_GBRAIN_TOKEN_URL,
    fetch: opts.fetch ?? fetch,
  });
}

export function createServerGbrainClient(opts: ServerGbrainClientOptions = {}): ServerGbrainClient {
  return new HttpServerGbrainClient({
    url: opts.url ?? process.env.PAPERCLIP_GBRAIN_MCP_URL ?? DEFAULT_GBRAIN_MCP_URL,
    bearerSource: resolveBearerSource(opts),
    fetch: opts.fetch ?? fetch,
    // The default budget covers HTTP + OAuth bearer mint (on first call after
    // refresh) + gbrain's postgres lookup + response. 500ms (the prior default)
    // was too aggressive: BLO-6388 flag-flip 2026-05-22 12:48Z observed 100%
    // gbrain_error verdicts whose underlying err.message was
    // "This operation was aborted" — the client-side AbortController firing
    // before the upstream call completed, especially with gbrain-mcp admin-ui
    // liveness flapping. 5s gives realistic headroom while still being
    // tight enough to keep the gate's preflight latency tail in check.
    timeoutMs: opts.timeoutMs ?? 5000,
  });
}
