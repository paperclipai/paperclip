import type { LogFn, LoggerOptions } from "pino";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactSensitiveText } from "../redaction.js";

export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "res.headers['set-cookie']",
] as const;

export function redactLoggerObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactEventPayload(object) ?? {};
}

export function redactLoggerText(text: string): string {
  return redactSensitiveText(text);
}

function redactLoggerArgument(arg: unknown): unknown {
  return typeof arg === "string" ? redactLoggerText(arg) : arg;
}

export function createLoggerRedactionOptions(): Pick<LoggerOptions, "redact" | "formatters" | "hooks"> {
  return {
    redact: {
      paths: [...HTTP_LOG_REDACT_PATHS],
      censor: REDACTED_EVENT_VALUE,
    },
    formatters: {
      log: redactLoggerObject,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(redactLoggerArgument) as Parameters<LogFn>);
      },
      streamWrite: redactLoggerText,
    },
  };
}
