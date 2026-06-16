import type { LoggingConfig } from "@paperclipai/shared";

export type LogLevel = "info" | "debug" | "warn";

const LOG_LEVELS: readonly LogLevel[] = ["info", "debug", "warn"];

function asLogLevel(value: string | undefined | null): LogLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized);
}

/**
 * Resolve the effective server log level.
 *
 * Precedence: PAPERCLIP_LOG_LEVEL env override -> logging.level from config ->
 * "info". The env override is the documented fast switch for re-enabling DEBUG
 * without editing the config file. An unrecognized value falls through to the
 * next source rather than throwing, so a typo never silences logging entirely.
 */
export function resolveLogLevel(configLevel: LoggingConfig["level"] | undefined): LogLevel {
  return asLogLevel(process.env.PAPERCLIP_LOG_LEVEL) ?? asLogLevel(configLevel) ?? "info";
}

/**
 * pino-http `req` serializer that logs only method, path, and client IP.
 *
 * The default pino-http serializer dumps the full header block, which on 4xx/5xx
 * responses writes the session `cookie` and the Cloudflare Access
 * `cf-access-jwt-assertion` token to disk in plaintext. Emitting only
 * method/url/remoteAddress removes that leak and cuts the per-line volume of the
 * 404 storm by ~10x. Never add `headers` back here.
 */
export function serializeHttpRequest(req: {
  method?: string;
  url?: string;
  remoteAddress?: string;
}): { method?: string; url?: string; remoteAddress?: string } {
  return {
    method: req.method,
    url: req.url,
    remoteAddress: req.remoteAddress,
  };
}
