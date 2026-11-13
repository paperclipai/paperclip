import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const CAPABILITY_BYTES = 32;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type CapabilityTailnetGatewayConfig = {
  bindHost: string;
  listenPort: number;
  upstreamHost: "127.0.0.1" | "::1";
  upstreamPort: number;
  publicOrigin: URL;
  buildIdentifier: string;
  sourceCommit: string;
  bundleSha256: string;
  staticSetSha256: string;
};

export type CapabilityTailnetAdmissionFailure = {
  status: number;
  code: string;
  message: string;
};

type AdmissionInput = {
  headers: IncomingHttpHeaders;
  method: string;
  pathname: string;
  expectedHost: string;
  expectedOrigin: string;
  capabilityValid: boolean;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Fetch Metadata is defense in depth, not the primary CSRF boundary.
 *
 * Safari and embedded/private browsers may omit one or all `Sec-Fetch-*`
 * headers. Exact Origin validation, a SameSite capability cookie, and the
 * high-entropy capability remain mandatory. When a Fetch Metadata header is
 * present, however, it must explicitly describe the expected same-origin
 * `fetch()` request.
 */
export function capabilityTailnetFetchMetadataAllowed(headers: IncomingHttpHeaders): boolean {
  const expectations = [
    ["sec-fetch-site", "same-origin"],
    ["sec-fetch-mode", "cors"],
    ["sec-fetch-dest", "empty"],
  ] as const;

  return expectations.every(([name, expected]) => {
    const actual = firstHeader(headers[name]);
    return actual === undefined || actual === expected;
  });
}

export function capabilityTailnetAdmissionFailure(
  input: AdmissionInput,
): CapabilityTailnetAdmissionFailure | null {
  const host = firstHeader(input.headers.host)?.toLowerCase() ?? "";
  if (host !== input.expectedHost) {
    return { status: 403, code: "host_denied", message: "Request host is not allowed." };
  }

  const isApi = input.pathname.startsWith("/api/capability/ui/");
  if (isApi && !input.capabilityValid) {
    return {
      status: 403,
      code: "capability_denied",
      message: "Preview capability is missing or expired.",
    };
  }

  const mutation = isApi && input.method !== "GET" && input.method !== "HEAD";
  if (!mutation) return null;

  if (firstHeader(input.headers.origin) !== input.expectedOrigin) {
    return { status: 403, code: "origin_denied", message: "Mutation origin is not allowed." };
  }

  if (!capabilityTailnetFetchMetadataAllowed(input.headers)) {
    return {
      status: 403,
      code: "fetch_metadata_denied",
      message: "Mutation request metadata is not allowed.",
    };
  }

  const contentType = (firstHeader(input.headers["content-type"]) ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return {
      status: 415,
      code: "content_type_denied",
      message: "Mutation body must be JSON.",
    };
  }

  return null;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "0");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Capability tailnet gateway requires valid listener and upstream ports");
  }
  return port;
}

export function resolveCapabilityTailnetGatewayConfig(
  env: NodeJS.ProcessEnv,
): CapabilityTailnetGatewayConfig {
  const bindHost = env.CAPABILITY_GATEWAY_BIND_HOST ?? "";
  const upstreamHost = env.CAPABILITY_UPSTREAM_HOST ?? "127.0.0.1";
  const publicOrigin = new URL(env.CAPABILITY_PUBLIC_ORIGIN ?? "");

  if (
    isIP(bindHost) === 0 ||
    (upstreamHost !== "127.0.0.1" && upstreamHost !== "::1") ||
    !["http:", "https:"].includes(publicOrigin.protocol) ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search !== "" ||
    publicOrigin.hash !== "" ||
    publicOrigin.username !== "" ||
    publicOrigin.password !== ""
  ) {
    throw new Error("Capability tailnet gateway requires an exact bind, loopback upstream, and public origin");
  }

  return {
    bindHost,
    listenPort: parsePort(env.CAPABILITY_GATEWAY_PORT),
    upstreamHost,
    upstreamPort: parsePort(env.CAPABILITY_UPSTREAM_PORT),
    publicOrigin,
    buildIdentifier: env.CAPABILITY_BUILD_IDENTIFIER ?? "unknown",
    sourceCommit: env.CAPABILITY_SOURCE_COMMIT ?? "unknown",
    bundleSha256: env.CAPABILITY_BUNDLE_SHA256 ?? "unknown",
    staticSetSha256: env.CAPABILITY_STATIC_SET_SHA256 ?? "unknown",
  };
}

function securityHeaders(secureTransport: boolean, headers: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return {
    ...headers,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...(secureTransport
      ? { "strict-transport-security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

export function createCapabilityTailnetGateway(config: CapabilityTailnetGatewayConfig): Server {
  const capability = randomBytes(CAPABILITY_BYTES).toString("base64url");
  const secureTransport = config.publicOrigin.protocol === "https:";
  const capabilityCookieName = secureTransport
    ? "__Host-paperclip_capability"
    : "paperclip_capability";
  const upstreamAuthority = config.upstreamHost.includes(":")
    ? `[${config.upstreamHost}]:${config.upstreamPort}`
    : `${config.upstreamHost}:${config.upstreamPort}`;
  const expectedHost = config.publicOrigin.host.toLowerCase();

  const sendJson = (
    response: ServerResponse,
    status: number,
    payload: unknown,
  ): void => {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(
      status,
      securityHeaders(secureTransport, {
        "cache-control": "no-store",
        "content-length": String(body.length),
        "content-type": "application/json; charset=utf-8",
      }),
    );
    response.end(body);
  };

  const capabilityValid = (cookieHeader: string | undefined): boolean => {
    let candidate = "";
    for (const segment of (cookieHeader ?? "").split(";")) {
      const index = segment.indexOf("=");
      if (index < 1) continue;
      if (segment.slice(0, index).trim() === capabilityCookieName) {
        candidate = segment.slice(index + 1).trim();
        break;
      }
    }
    if (candidate.length !== capability.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(capability));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", config.publicOrigin);

    if (url.pathname === "/__capability/health") {
      const probe = requestHttp(
        {
          host: config.upstreamHost,
          port: config.upstreamPort,
          method: "GET",
          path: "/",
          headers: { host: upstreamAuthority },
          timeout: 2_000,
        },
        (upstreamResponse) => {
          const upstreamStatus = upstreamResponse.statusCode ?? 0;
          upstreamResponse.resume();
          upstreamResponse.once("end", () => {
            const healthy = upstreamStatus >= 200 && upstreamStatus < 400;
            sendJson(response, healthy ? 200 : 503, {
              status: healthy ? "ok" : "unhealthy",
              buildIdentifier: config.buildIdentifier,
              sourceCommit: config.sourceCommit,
              bundleSha256: config.bundleSha256,
              staticSetSha256: config.staticSetSha256,
              runtime: "capability-clean-room",
              upstream: `loopback:${config.upstreamPort}`,
              upstreamStatus,
            });
          });
        },
      );
      probe.once("timeout", () => probe.destroy(new Error("health probe timeout")));
      probe.once("error", () => {
        if (!response.headersSent) {
          sendJson(response, 503, {
            status: "unhealthy",
            buildIdentifier: config.buildIdentifier,
            sourceCommit: config.sourceCommit,
            bundleSha256: config.bundleSha256,
            staticSetSha256: config.staticSetSha256,
            runtime: "capability-clean-room",
            upstream: `loopback:${config.upstreamPort}`,
            upstreamStatus: null,
          });
        }
      });
      probe.end();
      return;
    }

    const failure = capabilityTailnetAdmissionFailure({
      headers: request.headers,
      method: request.method ?? "GET",
      pathname: url.pathname,
      expectedHost,
      expectedOrigin: config.publicOrigin.origin,
      capabilityValid: capabilityValid(firstHeader(request.headers.cookie)),
    });
    if (failure !== null) {
      sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
      return;
    }

    const headers = { ...request.headers };
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
    headers.host = upstreamAuthority;
    headers["x-forwarded-host"] = expectedHost;
    headers["x-forwarded-proto"] = config.publicOrigin.protocol.slice(0, -1);
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "tailnet-peer";

    const isTurnStream =
      request.method === "POST" && url.pathname === "/api/capability/ui/message";
    if (isTurnStream) delete headers["accept-encoding"];

    const upstream = requestHttp(
      {
        host: config.upstreamHost,
        port: config.upstreamPort,
        method: request.method,
        path: request.url,
        headers,
        timeout: 125_000,
      },
      (upstreamResponse) => {
        const responseHeaders: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
        }
        if (isTurnStream) {
          delete responseHeaders["content-encoding"];
          delete responseHeaders["content-length"];
          responseHeaders["x-accel-buffering"] = "no";
        }
        if (
          request.method === "GET" &&
          url.pathname === "/" &&
          (upstreamResponse.statusCode ?? 500) < 400
        ) {
          responseHeaders["set-cookie"] = `${capabilityCookieName}=${capability}; Path=/; HttpOnly; SameSite=Strict${secureTransport ? "; Secure" : ""}`;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          securityHeaders(secureTransport, responseHeaders),
        );
        response.flushHeaders();
        upstreamResponse.pipe(response);
      },
    );

    upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.once("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 502, {
        error: { code: "upstream_unavailable", message: "Capability preview is unavailable." },
      });
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.maxConnections = 32;
  server.requestTimeout = 125_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function startCapabilityTailnetGateway(env: NodeJS.ProcessEnv = process.env): Server {
  const config = resolveCapabilityTailnetGatewayConfig(env);
  const server = createCapabilityTailnetGateway(config);
  server.listen(config.listenPort, config.bindHost, () => {
    process.stdout.write(
      `${JSON.stringify({
        event: "capability_tailnet_gateway_started",
        bindHost: config.bindHost,
        listenPort: config.listenPort,
        publicOrigin: config.publicOrigin.origin,
        upstreamHost: config.upstreamHost,
        upstreamPort: config.upstreamPort,
        buildIdentifier: config.buildIdentifier,
      })}\n`,
    );
  });
  return server;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = startCapabilityTailnetGateway();
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
