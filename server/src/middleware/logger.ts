import fs from "node:fs";
import path from "node:path";
import { env } from "node:process";
import pino from "pino";
import pinoHttp from "pino-http";

function resolveServerLogDir(): string {
  return env.PAPERCLIP_LOG_DIR ?? path.join(env.HOME ?? "/home/paperclip", ".paperclip", "instances", "default", "logs");
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

export const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
};

export const logger = pino(
  {
    name: "paperclipai",
    level: env.PAPERCLIP_LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
    ...sharedOpts,
  },
  pino.multistream([
    {
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true, ...sharedOpts, minimumLevel: "info" },
      }),
      level: "info",
    },
    {
      stream: pino.destination({ dest: logFile, sync: false }),
      level: "debug",
    },
  ]),
);

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: { ...req.headers, authorization: req.headers?.authorization ? "[redacted]" : undefined },
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  customLogLevel(req, res, err) {
    if (res.statusCode === 304) {
      return "debug";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "debug";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
});
