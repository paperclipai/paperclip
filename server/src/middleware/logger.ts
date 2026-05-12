import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pino, { stdSerializers } from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { sanitizeRecord, redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

// 64 KiB cap on logged request bodies. Bodies above this size are replaced
// with a sentinel rather than walked; prevents log-flood DoS via large payloads
// and bounds the cost of `sanitizeRecord` on pathological input.
export const MAX_LOGGED_BODY_BYTES = 64 * 1024;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "api_key",
  "apikey",
  "password",
  "code",
  "state",
]);

export function scrubUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  try {
    // req.url is path-relative; supply a dummy absolute base so URL parses it.
    const parsed = new URL(rawUrl, "http://internal.invalid");
    let mutated = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, REDACTED_EVENT_VALUE);
        mutated = true;
      }
    }
    if (mutated) {
      // Once we've structurally redacted, skip the text-based scrub: its
      // ENV_SECRET_ASSIGNMENT_TEXT_RE is greedy on `[^\s]+` and would swallow
      // the `&other_param=...` tail that follows our `***REDACTED***` value.
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return redactSensitiveText(rawUrl);
  } catch {
    return redactSensitiveText(rawUrl);
  }
}

export function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED_EVENT_VALUE : value;
  }
  return out;
}

// Better-auth mounts at /api/auth/*. Body shapes (passwords, OAuth codes,
// reset tokens, callback URLs) evolve with the upstream library, so an
// allowlist of field names is fragile — drop the body entirely on failures
// and rely on status code + error message for diagnosis.
export function isAuthPath(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("/api/auth/");
}

// `sanitizeRecord` (from redaction.ts) catches `password`, `apiKey`,
// `authToken`, `access_token`, etc. — but its regex `auth(?:_?token)?`
// requires the `auth` prefix on `token` and so misses bare `token`. The
// logger needs broader coverage because we surface arbitrary user-submitted
// bodies on every 4xx/5xx; widen with the keys below as a Layer B-only scrub.
const LOGGER_EXTRA_SECRET_KEY_RE = /^token$/i;

function scrubExtraSecretKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubExtraSecretKeys);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = LOGGER_EXTRA_SECRET_KEY_RE.test(k) ? REDACTED_EVENT_VALUE : scrubExtraSecretKeys(v);
  }
  return out;
}

export function redactBodyForLog(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body !== "object") return body;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return "[unserializable]";
  }
  if (serialized.length > MAX_LOGGED_BODY_BYTES) return "[omitted: body too large]";
  const sanitized = Array.isArray(body)
    ? body.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? sanitizeRecord(entry as Record<string, unknown>)
          : entry,
      )
    : sanitizeRecord(body as Record<string, unknown>);
  return scrubExtraSecretKeys(sanitized);
}

export const logger = pino({
  level: "debug",
  // Layer A — structural: pino-level scrub for known sensitive paths so any
  // future code path that attaches these fields is safe by default. Layer B
  // (sanitizeRecord in customProps below) handles deep recursion that pino's
  // path syntax cannot express.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["set-cookie"]',
      'req.headers["x-api-key"]',
      'req.headers["proxy-authorization"]',
      'res.headers["set-cookie"]',
      "reqBody.password",
      "reqBody.currentPassword",
      "reqBody.newPassword",
      "reqBody.token",
      "reqBody.apiKey",
      "reqBody.api_key",
      "reqBody.accessToken",
      "reqBody.refreshToken",
      "reqBody.secret",
      "reqBody.*.password",
      "reqBody.*.token",
      "reqBody.*.apiKey",
      "reqQuery.token",
      "reqQuery.access_token",
      "reqQuery.api_key",
    ],
    censor: REDACTED_EVENT_VALUE,
    remove: false,
  },
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    // pino-http's default req serializer dumps full req.url (including query
    // string) and req.headers. Wrap pino's standard serializer to scrub
    // sensitive query params and headers before they hit the file transport.
    req: (req: Parameters<typeof stdSerializers.req>[0]) => {
      const serialized = stdSerializers.req(req);
      if (typeof serialized.url === "string") {
        serialized.url = scrubUrl(serialized.url);
      }
      if (serialized.headers && typeof serialized.headers === "object") {
        serialized.headers = redactHeaders(serialized.headers) as typeof serialized.headers;
      }
      return serialized;
    },
  },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${scrubUrl(req.url ?? "")} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${scrubUrl(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
  },
  customProps: buildErrorLogProps,
});

export function buildErrorLogProps(
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, unknown> {
  const statusCode = res.statusCode ?? 0;
  if (statusCode < 400) return {};
  const r = req as IncomingMessage & Record<string, unknown>;
  const requestUrl = (r.originalUrl as string | undefined) ?? (r.url as string | undefined) ?? "";
  const skipBody = isAuthPath(requestUrl);
  const ctx = (res as ServerResponse & {
    __errorContext?: { error?: unknown; reqBody?: unknown; reqParams?: unknown; reqQuery?: unknown };
  }).__errorContext;
  if (ctx) {
    const props: Record<string, unknown> = {};
    if (ctx.error !== undefined) props.errorContext = ctx.error;
    if (!skipBody && ctx.reqBody !== undefined) props.reqBody = redactBodyForLog(ctx.reqBody);
    if (ctx.reqParams !== undefined) props.reqParams = redactBodyForLog(ctx.reqParams);
    if (ctx.reqQuery !== undefined) props.reqQuery = redactBodyForLog(ctx.reqQuery);
    return props;
  }
  const props: Record<string, unknown> = {};
  const body = r.body;
  const params = r.params;
  const query = r.query;
  if (!skipBody && body && typeof body === "object" && Object.keys(body as object).length > 0) {
    props.reqBody = redactBodyForLog(body);
  }
  if (params && typeof params === "object" && Object.keys(params as object).length > 0) {
    props.reqParams = redactBodyForLog(params);
  }
  if (query && typeof query === "object" && Object.keys(query as object).length > 0) {
    props.reqQuery = redactBodyForLog(query);
  }
  const route = r.route as { path?: string } | undefined;
  if (route?.path) {
    props.routePath = route.path;
  }
  return props;
}
