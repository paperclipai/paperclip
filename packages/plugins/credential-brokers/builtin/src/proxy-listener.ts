import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";

import type { BrokerSession, SessionStore } from "./session-store.js";
import { rewriteHeadersForUpstream } from "./header-injection.js";

/**
 * TLS-MITM HTTP CONNECT proxy listener for the credential broker.
 *
 * Lifecycle of a single request through this proxy:
 *
 *   agent ── CONNECT api.github.com:443 ──▶ proxy
 *                                            │
 *                                            ▼
 *                              authenticate `Proxy-Authorization: Bearer <sessionToken>`
 *                                            │
 *                                            ▼
 *                              match `api.github.com` against session.hostRules
 *                                            │
 *                                            ▼
 *                              respond `200 Connection established`
 *                                            │
 *                                            ▼
 *                              wrap raw socket in TLSSocket with the per-session
 *                              CA-signed leaf for `api.github.com`
 *                                            │
 *                                            ▼
 *                              hand TLS-terminated socket to inner http server
 *                                            │
 *                                            ▼
 *                              parse the inner HTTP request, strip any placeholder
 *                              header values, inject Authorization from bearer cache
 *                                            │
 *                                            ▼
 *                              forward to upstream over verified TLS, stream the
 *                              response back to the agent over the MITM TLS
 *
 * The agent never sees the real OAuth bearer. The proxy logs the
 * request shape (method, host, path, status, latency, credential key)
 * but does not log headers, query strings, or bodies.
 */

export interface ProxyLogEntry {
  runId: string;
  companyId: string;
  sessionToken: string;
  method: string;
  host: string;
  path: string;
  status: number;
  latencyMs: number;
  injectedFor?: string;            // connectionId, if a bearer was injected
  reason?: "host_not_allowed" | "no_session" | "no_bearer" | "upstream_error";
}

export type ProxyLogger = (entry: ProxyLogEntry) => void;

export interface ProxyListener {
  /** Begin listening on the supplied host:port. Loopback by default. */
  listen(opts?: { host?: string; port?: number }): Promise<void>;
  /** Address in the form host:port suitable for HTTPS_PROXY. */
  proxyUrl(): string;
  /** Stop accepting new connections; existing sockets drain. */
  close(): Promise<void>;
}

export interface CreateProxyListenerInput {
  store: SessionStore;
  /** Optional log sink; defaults to a no-op. */
  log?: ProxyLogger;
  /**
   * Optional TLS overrides applied to upstream https.request calls.
   * Production deployments leave this undefined and rely on the host's
   * system CA bundle. Tests use this to supply a self-signed test CA
   * so the proxy can verify the stub upstream's cert without globally
   * disabling TLS verification.
   */
  upstreamTlsOpts?: { ca?: string | Buffer };
}

// Internal: attach the session + upstream host:port to the TLS socket so the
// inner HTTP server can recover them when it sees the request.
interface AnnotatedTlsSocket extends TLSSocket {
  __brokerSession?: BrokerSession;
  __brokerUpstreamHost?: string;
  __brokerUpstreamPort?: number;
}

/**
 * Parse a CONNECT target of the form `host:port` or `[ipv6]:port`. Falls
 * back to port 443 when the port portion is missing or malformed. The
 * host is returned without brackets so it can be used directly as the
 * `host` field on `https.request` (Node accepts unbracketed IPv6 there)
 * and as the SNI servername for the per-session leaf.
 *
 * @internal — exported for unit testing.
 */
export function parseConnectTarget(url: string): { host: string; port: number } {
  // Bracketed IPv6: [::1]:443
  if (url.startsWith("[")) {
    const close = url.indexOf("]");
    if (close === -1) return { host: url, port: 443 };
    const host = url.slice(1, close);
    const rest = url.slice(close + 1);
    if (!rest.startsWith(":")) return { host, port: 443 };
    const port = Number.parseInt(rest.slice(1), 10);
    return { host, port: Number.isFinite(port) ? port : 443 };
  }
  // Plain host:port; last colon separates (DNS labels can't contain `:`).
  const lastColon = url.lastIndexOf(":");
  if (lastColon === -1) return { host: url, port: 443 };
  const host = url.slice(0, lastColon);
  const port = Number.parseInt(url.slice(lastColon + 1), 10);
  return { host, port: Number.isFinite(port) ? port : 443 };
}

export function createProxyListener(
  input: CreateProxyListenerInput,
): ProxyListener {
  const log = input.log ?? (() => undefined);

  // Inner HTTP server processes the TLS-terminated requests. It never
  // binds to a TCP port — sockets are fed directly via `emit('connection', socket)`.
  const innerHttp = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const sock = req.socket as AnnotatedTlsSocket;
      const session = sock.__brokerSession;
      const upstreamHost = sock.__brokerUpstreamHost;
      const upstreamPort = sock.__brokerUpstreamPort ?? 443;
      const startedAt = Date.now();
      if (!session || !upstreamHost) {
        res.writeHead(500);
        res.end();
        return;
      }
      const rule = session.hostRules.get(upstreamHost.toLowerCase());
      const bearer = rule ? session.bearerFor(rule.connectionId) : undefined;
      const knownPlaceholders = Object.values(session.placeholders);
      const rewrite = rewriteHeadersForUpstream({
        headers: req.headers,
        rule,
        bearer,
        knownPlaceholders,
      });

      const upstreamHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(rewrite.headers)) {
        if (v !== undefined) upstreamHeaders[k] = v;
      }
      // Some headers shouldn't pass through unchanged. The host header
      // must reflect the upstream so SNI matches; the proxy-* headers
      // are scoped to the agent↔proxy hop.
      upstreamHeaders.host = upstreamHost;
      delete (upstreamHeaders as Record<string, unknown>)["proxy-authorization"];
      delete (upstreamHeaders as Record<string, unknown>)["proxy-connection"];

      const upstreamOpts: RequestOptions = {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders,
        ...(input.upstreamTlsOpts ?? {}),
      };
      const upstreamReq = httpsRequest(upstreamOpts, (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          upstreamRes.headers,
        );
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => {
          log({
            runId: session.runId,
            companyId: session.companyId,
            sessionToken: session.sessionToken,
            method: req.method ?? "GET",
            host: upstreamHost,
            path: req.url ?? "/",
            status: upstreamRes.statusCode ?? 0,
            latencyMs: Date.now() - startedAt,
            injectedFor: rewrite.injected ? rule?.connectionId : undefined,
            reason: !rewrite.injected ? "no_bearer" : undefined,
          });
        });
      });
      upstreamReq.on("error", (err) => {
        log({
          runId: session.runId,
          companyId: session.companyId,
          sessionToken: session.sessionToken,
          method: req.method ?? "GET",
          host: upstreamHost,
          path: req.url ?? "/",
          status: 502,
          latencyMs: Date.now() - startedAt,
          reason: "upstream_error",
        });
        if (!res.headersSent) res.writeHead(502);
        res.end(`upstream error: ${err.message}`);
      });
      req.pipe(upstreamReq);
    },
  );

  // Outer proxy handles plain HTTP forward-proxy requests (rare for OAuth
  // traffic) and the CONNECT upgrade for HTTPS.
  const outer = createHttpServer((req, res) => {
    // Plain HTTP forward-proxy: rare for OAuth bearers; we only support
    // CONNECT in M2. Reject loudly so we never accidentally forward
    // plaintext credentials over unencrypted upstream.
    res.writeHead(405, { "x-paperclip-broker-reason": "use_connect_for_https" });
    res.end();
  });

  outer.on("connect", (req, socket, head) => {
    const startedAt = Date.now();
    const { host, port } = parseConnectTarget(req.url ?? "");
    const auth = req.headers["proxy-authorization"];
    const authToken = typeof auth === "string"
      ? auth.replace(/^\s*Bearer\s+/i, "")
      : "";
    const session = authToken ? input.store.get(authToken) : undefined;

    if (!session) {
      socket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          "Proxy-Authenticate: Bearer realm=\"paperclip-broker\"\r\n" +
          "Connection: close\r\n\r\n",
      );
      socket.end();
      log({
        runId: "unknown",
        companyId: "unknown",
        sessionToken: "",
        method: "CONNECT",
        host,
        path: req.url ?? "",
        status: 407,
        latencyMs: Date.now() - startedAt,
        reason: "no_session",
      });
      return;
    }

    if (!session.hostRules.has(host.toLowerCase())) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "X-Paperclip-Broker-Reason: host_not_allowed\r\n" +
          "Connection: close\r\n\r\n",
      );
      socket.end();
      log({
        runId: session.runId,
        companyId: session.companyId,
        sessionToken: session.sessionToken,
        method: "CONNECT",
        host,
        path: req.url ?? "",
        status: 403,
        latencyMs: Date.now() - startedAt,
        reason: "host_not_allowed",
      });
      return;
    }

    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");

    const { keyPem, certPem } = session.ca.signLeaf(host);
    const tlsSocket = new TLSSocket(socket, {
      isServer: true,
      key: keyPem,
      // Concatenate leaf + session CA so clients that don't already
      // have the CA in their trust list still see a complete chain.
      cert: `${certPem}${session.ca.caPem}`,
    }) as AnnotatedTlsSocket;
    tlsSocket.__brokerSession = session;
    tlsSocket.__brokerUpstreamHost = host;
    tlsSocket.__brokerUpstreamPort = port;
    if (head.length > 0) tlsSocket.unshift(head);

    tlsSocket.on("error", () => {
      // Swallow — the upstream/agent will see a TLS abort. Logging happens
      // when the inner http server completes (or doesn't).
    });

    innerHttp.emit("connection", tlsSocket);
  });

  let listenAddress: string | undefined;
  let server: HttpServer | undefined;

  return {
    async listen(opts: { host?: string; port?: number } = {}) {
      const host = opts.host ?? "127.0.0.1";
      const port = opts.port ?? 0;
      server = outer;
      await new Promise<void>((resolve, reject) => {
        outer.once("error", reject);
        outer.listen(port, host, () => {
          const addr = outer.address() as AddressInfo;
          listenAddress = `${host}:${addr.port}`;
          resolve();
        });
      });
    },
    proxyUrl(): string {
      if (!listenAddress) throw new Error("proxy listener not started");
      return `http://${listenAddress}`;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
