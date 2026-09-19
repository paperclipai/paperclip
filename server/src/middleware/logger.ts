import pino from "pino";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import {
  isPrivateChatWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import {
  redactSensitive,
  stripSecretBearingUrlParts,
} from "./redact-sensitive.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const isProduction = process.env.NODE_ENV === "production";

// One pretty-print transport per process, even when this module is evaluated
// more than once.
//
// `pino.transport` spawns a worker thread (thread-stream) and hands back no
// handle this module could close, so every extra evaluation leaks one worker
// thread, one MessagePort and that worker's whole V8 isolate for the life of
// the process. A server process evaluates this module once, so the cache is
// inert in production. The server test suites do not: 46 files under
// `server/src/__tests__` call `vi.resetModules()` in `beforeEach` and then
// re-import a module that reaches this one, so the module is evaluated once
// per test and a 50-test suite ends holding 50 live worker threads.
//
// Measured cost of the leak: 400 transports in one process reach 407 threads
// and 1.68 GB RSS, so a 50-test suite carries roughly 280 MB of dead workers.
// `server/vitest.config.ts` pins `maxWorkers: 1`, so those suites run one at a
// time on one runner and each pays the whole cost.
//
// The cache lives on `globalThis` on purpose: a module-scoped variable is
// discarded by the very module-registry reset this guards against.
const PRETTY_TRANSPORT_KEY = "__paperclipPinoPrettyTransport";
type PrettyTransportCache = {
  [PRETTY_TRANSPORT_KEY]?: ReturnType<typeof pino.transport>;
};

/**
 * The process's one pretty-print transport, created on first use. See the note
 * above for why it is cached rather than built per module evaluation.
 */
function prettyTransport() {
  const cache = globalThis as typeof globalThis & PrettyTransportCache;
  cache[PRETTY_TRANSPORT_KEY] ??= pino.transport({
    target: "pino-pretty",
    options: {
      ...sharedOpts,
      ignore: "pid,hostname,req,res,responseTime",
      colorize: true,
      destination: 1,
    },
  });
  return cache[PRETTY_TRANSPORT_KEY];
}

export const logger = isProduction
  ? pino({
      level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info",
      redact: [...HTTP_LOG_REDACT_PATHS],
    })
  : pino(
      {
        level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug",
        redact: [...HTTP_LOG_REDACT_PATHS],
      },
      prettyTransport(),
    );

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateChatWebhookHttpRequest(
    req.method,
    requestClassificationUrl(req),
  );
}

function requestLogUrl(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateWebhook(req)
    ? "/api/chat-webhooks/:publicId/:provider"
    : stripSecretBearingUrlParts(typeof req.url === "string" ? req.url : "");
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      req(req: Record<string, unknown> & { url?: unknown }) {
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // pino's standard request serializer has already selected originalUrl.
          // A closed projection also excludes params, arbitrary headers and any
          // parser/SDK-added body copies, including Buffer numeric byte keys.
          return {
            id: req.id,
            method: req.method,
            url: "/api/chat-webhooks/:publicId/:provider",
          };
        }
        return {
          ...req,
          url:
            typeof req.url === "string"
              ? stripSecretBearingUrlParts(req.url)
              : req.url,
          // The URL policy intentionally drops all query parameters. The default
          // serializer also exposes the parsed query separately, so omit that
          // duplicate path instead of letting credentials bypass the URL scrub.
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          raw?: {
            req?: { method?: string; originalUrl?: unknown; url?: unknown };
          };
        },
      ) {
        // A provider error may also be reflected in response headers. Keep the
        // same content-free contract on both sides of a webhook request.
        return res.raw?.req && isPrivateWebhook(res.raw.req)
          ? { statusCode: res.statusCode }
          : res;
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
      return `${req.method} ${requestLogUrl(req)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      if (
        isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))
      ) {
        return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`;
      }
      const ctx = (res as any).__errorContext;
      const errMsg =
        ctx?.error?.message ||
        err?.message ||
        (res as any).err?.message ||
        "unknown error";
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
    },
    customErrorObject(req, _res, _err, value) {
      // pino-http serializes res.err independently of customProps/errorContext.
      // Do not rely on a particular error handler having sanitized an SDK Error.
      return isPrivateWebhook(req)
        ? {
            ...value,
            err: { type: "Error", message: "Chat webhook request failed" },
          }
        : value;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (isPrivateWebhook(req)) {
          // Omit, rather than recursively redact, the entire provider payload.
          // This applies equally before/after parsing and with/without context.
          return {
            reqBody: "[REDACTED]",
            ...(ctx || (res as any).err
              ? { errorContext: { name: "Error" } }
              : {}),
          };
        }
        if (ctx) {
          const secretSensitiveRoute = isSecretSensitiveHttpRequest(
            req.method,
            requestClassificationUrl(req),
          );
          return {
            // Provider SDK and validation errors sometimes echo the supplied
            // credential in their prose. Keep only a non-sensitive type marker
            // for setup routes; the status, route, and redacted body remain.
            errorContext: secretSensitiveRoute
              ? { name: "Error" }
              : redactSensitive(ctx.error),
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (
          params &&
          typeof params === "object" &&
          Object.keys(params).length > 0
        ) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
