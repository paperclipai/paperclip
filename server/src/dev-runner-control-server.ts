import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface StartedDevRunnerControlServer {
  close(): Promise<void>;
  listenPort: number;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown, origin?: string | null) {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function allowOrigin(req: IncomingMessage, res: ServerResponse, allowedOrigins: Set<string>): string | null {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin || !allowedOrigins.has(origin)) {
    writeJson(res, 403, { error: "Origin not allowed" });
    return null;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  return origin;
}

function discardRequestBody(req: IncomingMessage): void {
  req.on("data", () => {});
  req.resume();
}

export async function startDevRunnerControlServer(options: {
  port: number;
  host?: string;
  getAllowedOrigins: () => string[];
  isOriginAllowed?: (origin: string) => boolean;
  onRestartRequested: () => void | Promise<void>;
  onError?: (error: Error) => void;
}): Promise<StartedDevRunnerControlServer> {
  const server = createServer((req, res) => {
    const allowedOrigins = new Set(
      options.getAllowedOrigins()
        .map((origin) => normalizeOrigin(origin))
        .filter((origin): origin is string => origin !== null),
    );
    const allowRequestOrigin = (request: IncomingMessage, response: ServerResponse) => {
      const origin = normalizeOrigin(request.headers.origin);
      if (
        origin &&
        options.isOriginAllowed?.(origin) &&
        !allowedOrigins.has(origin)
      ) {
        allowedOrigins.add(origin);
      }
      return allowOrigin(request, response, allowedOrigins);
    };

    if (req.method === "OPTIONS") {
      const origin = allowRequestOrigin(req, res);
      if (!origin) return;
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.url !== "/restart") {
      writeJson(res, 404, { error: "Route not found" });
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const origin = allowRequestOrigin(req, res);
    if (!origin) return;

    discardRequestBody(req);
    const requestId = randomUUID();
    const requestedAt = new Date().toISOString();
    writeJson(res, 202, {
      accepted: true,
      requestId,
      requestedAt,
    }, origin);

    queueMicrotask(() => {
      Promise.resolve(options.onRestartRequested()).catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        options.onError?.(err);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dev-runner control server did not expose a numeric listen port");
  }

  return {
    listenPort: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
