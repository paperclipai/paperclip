import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";

const REDACTED_QUERY_VALUE = "[REDACTED]";
const CLI_AUTH_TOKEN_PREFIX = "pcp_cli_auth_";
const SENSITIVE_QUERY_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "clientsecret",
  "idtoken",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "token",
]);

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function normalizeQueryKey(key: string): string {
  return decodeQueryComponent(key).replace(/[-_]/g, "").toLowerCase();
}

function queryKeyCandidates(key: string): string[] {
  const decodedKey = decodeQueryComponent(key);
  const candidates = [decodedKey.replace(/\[[^\]]*\]/g, "")];
  for (const match of decodedKey.matchAll(/\[([^\]]*)\]/g)) {
    if (match[1]) candidates.push(match[1]);
  }
  return candidates.map(normalizeQueryKey).filter(Boolean);
}

function isSensitiveQueryKey(key: string): boolean {
  return queryKeyCandidates(key).some((candidate) => SENSITIVE_QUERY_KEYS.has(candidate));
}

function valueContainsSensitiveQueryKey(value: string): boolean {
  const decodedValue = decodeQueryComponent(value);
  const queryKeyPattern = /(?:^|[?&#])([^=&#?]+)=/g;
  let match: RegExpExecArray | null;
  while ((match = queryKeyPattern.exec(decodedValue)) !== null) {
    if (isSensitiveQueryKey(match[1])) return true;
  }
  return false;
}

function isSensitiveQuerySegment(rawKey: string, rawValue: string): boolean {
  const decodedValue = decodeQueryComponent(rawValue);
  return isSensitiveQueryKey(rawKey) ||
    rawValue.includes(CLI_AUTH_TOKEN_PREFIX) ||
    decodedValue.includes(CLI_AUTH_TOKEN_PREFIX) ||
    valueContainsSensitiveQueryKey(rawValue);
}

function queryValueContainsSensitiveToken(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") {
    return value.includes(CLI_AUTH_TOKEN_PREFIX) ||
      decodeQueryComponent(value).includes(CLI_AUTH_TOKEN_PREFIX) ||
      valueContainsSensitiveQueryKey(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => queryValueContainsSensitiveToken(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((entry) => queryValueContainsSensitiveToken(entry, depth + 1));
  }
  return false;
}

function redactHttpLogQuery(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (value === null || typeof value !== "object") {
    return queryValueContainsSensitiveToken(value) ? REDACTED_QUERY_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHttpLogQuery(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveQueryKey(key) || queryValueContainsSensitiveToken(entry)) {
      out[key] = REDACTED_QUERY_VALUE;
      continue;
    }
    out[key] = redactHttpLogQuery(entry, depth + 1);
  }
  return out;
}

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((segment) => {
      if (segment.length === 0) return segment;
      const equalsIndex = segment.indexOf("=");
      const rawKey = equalsIndex >= 0 ? segment.slice(0, equalsIndex) : segment;
      const rawValue = equalsIndex >= 0 ? segment.slice(equalsIndex + 1) : "";
      return isSensitiveQuerySegment(rawKey, rawValue) ? `${rawKey}=${REDACTED_QUERY_VALUE}` : segment;
    })
    .join("&");
}

export function redactHttpLogUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  const hashIndex = rawUrl.indexOf("#");
  const beforeHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return rawUrl;
  const path = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  return `${path}?${redactQueryString(query)}${hash}`;
}

function serializeRequestForLog(req: unknown): Record<string, unknown> {
  const stdReqSerializer = pino.stdSerializers?.req;
  const serialized = stdReqSerializer
    ? (stdReqSerializer(req as any) as unknown as Record<string, unknown>)
    : { ...(req as Record<string, unknown>) };
  if (typeof serialized.url === "string") {
    serialized.url = redactHttpLogUrl(serialized.url);
  }
  if (serialized.query && typeof serialized.query === "object") {
    serialized.query = redactHttpLogQuery(serialized.query);
  }
  return serialized;
}

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

export const logger = pino({
  level: "debug",
  redact: ["req.headers.authorization"],
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
    req: serializeRequestForLog,
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
    return `${req.method} ${redactHttpLogUrl(req.url)} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${redactHttpLogUrl(req.url)} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          reqQuery: redactHttpLogQuery(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactHttpLogQuery(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
