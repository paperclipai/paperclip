import { randomUUID } from "node:crypto";

export const LOCAL_RUNNER_BROWSER_LIMITS = Object.freeze({
  maxActiveRuns: 4,
  maxRetainedRuns: 16,
  maxRequestBodyBytes: 16 * 1024,
  maxStreamClientsPerRun: 8,
});

class LocalRunnerHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeLimits(overrides = {}) {
  const limits = {
    maxActiveRuns: positiveInteger(
      overrides.maxActiveRuns ?? LOCAL_RUNNER_BROWSER_LIMITS.maxActiveRuns,
      "maxActiveRuns",
    ),
    maxRetainedRuns: positiveInteger(
      overrides.maxRetainedRuns ?? LOCAL_RUNNER_BROWSER_LIMITS.maxRetainedRuns,
      "maxRetainedRuns",
    ),
    maxRequestBodyBytes: positiveInteger(
      overrides.maxRequestBodyBytes ?? LOCAL_RUNNER_BROWSER_LIMITS.maxRequestBodyBytes,
      "maxRequestBodyBytes",
    ),
    maxStreamClientsPerRun: positiveInteger(
      overrides.maxStreamClientsPerRun ??
        LOCAL_RUNNER_BROWSER_LIMITS.maxStreamClientsPerRun,
      "maxStreamClientsPerRun",
    ),
  };
  if (limits.maxRetainedRuns < limits.maxActiveRuns) {
    throw new TypeError("maxRetainedRuns must be at least maxActiveRuns");
  }
  return limits;
}

function isLoopbackAddress(address) {
  if (typeof address !== "string") {
    return false;
  }
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "[::1]" || normalized === "localhost") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function requestOrigin(request) {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    throw new LocalRunnerHttpError(403, "Local runner requests require a loopback Host");
  }
  const protocol = request.socket.encrypted === true ? "https:" : "http:";
  let hostUrl;
  try {
    hostUrl = new URL(`${protocol}//${host}`);
  } catch {
    throw new LocalRunnerHttpError(403, "Local runner requests require a valid loopback Host");
  }
  if (!isLoopbackAddress(hostUrl.hostname)) {
    throw new LocalRunnerHttpError(403, "Local runner requests require a loopback Host");
  }
  const defaultPort = protocol === "https:" ? 443 : 80;
  const hostPort = hostUrl.port.length === 0 ? defaultPort : Number(hostUrl.port);
  if (hostPort !== request.socket.localPort) {
    throw new LocalRunnerHttpError(403, "Local runner Host must name the listening loopback port");
  }
  return hostUrl.origin;
}

function assertTrustedTransport(request) {
  if (
    !isLoopbackAddress(request.socket.localAddress) ||
    !isLoopbackAddress(request.socket.remoteAddress)
  ) {
    throw new LocalRunnerHttpError(403, "Local runner is available only over loopback");
  }
  const expectedOrigin = requestOrigin(request);
  const origin = request.headers.origin;
  if (Array.isArray(origin) || (typeof origin === "string" && origin !== expectedOrigin)) {
    throw new LocalRunnerHttpError(403, "Local runner requests must be same-origin");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    Array.isArray(fetchSite) ||
    (typeof fetchSite === "string" && !["same-origin", "none"].includes(fetchSite))
  ) {
    throw new LocalRunnerHttpError(403, "Local runner cross-site requests are forbidden");
  }
}

function declaredBodyBytes(request) {
  const header = request.headers["content-length"];
  if (header === undefined) {
    return null;
  }
  if (Array.isArray(header) || !/^\d+$/.test(header)) {
    throw new LocalRunnerHttpError(400, "Invalid Content-Length");
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value)) {
    throw new LocalRunnerHttpError(413, "Local runner request body is too large");
  }
  return value;
}

function rejectDeclaredOversize(request, maxBytes) {
  const contentLength = declaredBodyBytes(request);
  if (contentLength !== null && contentLength > maxBytes) {
    request.resume();
    throw new LocalRunnerHttpError(
      413,
      `Local runner request body exceeds ${maxBytes} bytes`,
    );
  }
}

function readJson(request, maxBytes) {
  rejectDeclaredOversize(request, maxBytes);
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    request.resume();
    throw new LocalRunnerHttpError(415, "Local runner request bodies must use application/json");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error, drain = false) => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      cleanup();
      if (drain) {
        request.resume();
      }
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBytes) {
        fail(
          new LocalRunnerHttpError(
            413,
            `Local runner request body exceeds ${maxBytes} bytes`,
          ),
          true,
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        const source = Buffer.concat(chunks, receivedBytes).toString("utf8");
        resolve(source.length === 0 ? {} : JSON.parse(source));
      } catch {
        reject(new LocalRunnerHttpError(400, "Local runner request body must be valid JSON"));
      }
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new LocalRunnerHttpError(400, "Request body was aborted"));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function writeRecord(response, value) {
  response.write(`${JSON.stringify(value)}\n`);
}

function sendError(response, error, fallbackStatus = 400) {
  const status = error instanceof LocalRunnerHttpError ? error.status : fallbackStatus;
  const message = error instanceof Error ? error.message : String(error);
  json(response, status, { error: message });
}

async function loadLocalRunnerRunner() {
  const runnerModuleUrl = new URL(
    "../dist/mock-core/local-runner.js",
    import.meta.url,
  ).href;
  return import(runnerModuleUrl);
}

export function createLocalRunnerBrowserMiddleware(options = {}) {
  const limits = normalizeLimits(options.limits);
  const loadRunner = options.loadRunner ?? loadLocalRunnerRunner;
  const runs = new Map();
  let startingRuns = 0;

  const activeRunCount = () =>
    [...runs.values()].filter((entry) => !entry.finished).length;

  const pruneFinishedRuns = (targetSize) => {
    for (const [id, entry] of runs) {
      if (runs.size <= targetSize) {
        return;
      }
      if (entry.finished) {
        runs.delete(id);
      }
    }
  };

  return async function middleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://localRunner.local");
    if (!url.pathname.startsWith("/api/localRunner/")) {
      next();
      return;
    }

    try {
      assertTrustedTransport(request);
      rejectDeclaredOversize(request, limits.maxRequestBodyBytes);
    } catch (error) {
      sendError(response, error, 403);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/localRunner/runs") {
      if (activeRunCount() + startingRuns >= limits.maxActiveRuns) {
        json(response, 429, { error: "Local runner active-run limit reached" });
        return;
      }
      pruneFinishedRuns(limits.maxRetainedRuns - 1);
      if (runs.size + startingRuns >= limits.maxRetainedRuns) {
        json(response, 429, { error: "Local runner retained-run limit reached" });
        return;
      }

      startingRuns += 1;
      try {
        const body = await readJson(request, limits.maxRequestBodyBytes);
        const runner = await loadRunner();
        const id = randomUUID();
        const history = [];
        const clients = new Set();
        const publish = (record) => {
          history.push(record);
          for (const client of clients) {
            writeRecord(client, record);
          }
        };
        const handle = await runner.startLocalRunnerScenario({
          scenario: body.scenario,
          delayMs: 30,
          onEvent(event) {
            publish({ kind: "event", event });
          },
          onDiagnostic(message) {
            publish({ kind: "diagnostic", message });
          },
        });
        const entry = { id, handle, history, clients, finished: false, trace: null };
        runs.set(id, entry);
        handle.completion.then(
          (trace) => {
            entry.trace = trace;
            entry.finished = true;
            publish({ kind: "trace", trace });
            for (const client of clients) {
              client.end();
            }
            clients.clear();
            pruneFinishedRuns(limits.maxRetainedRuns);
          },
          (error) => {
            entry.finished = true;
            publish({ kind: "error", message: String(error) });
            for (const client of clients) {
              client.end();
            }
            clients.clear();
            pruneFinishedRuns(limits.maxRetainedRuns);
          },
        );
        json(response, 201, { id, metadata: handle.metadata });
      } catch (error) {
        sendError(response, error);
      } finally {
        startingRuns -= 1;
      }
      return;
    }

    const match = url.pathname.match(
      /^\/api\/localRunner\/runs\/([^/]+)(?:\/(events|interrupt|resolve))?$/,
    );
    if (match === null) {
      json(response, 404, { error: "Local runner route not found" });
      return;
    }
    const entry = runs.get(match[1]);
    if (entry === undefined) {
      json(response, 404, { error: "Local runner run not found" });
      return;
    }
    const action = match[2];
    if (request.method === "GET" && action === "events") {
      if (!entry.finished && entry.clients.size >= limits.maxStreamClientsPerRun) {
        json(response, 429, { error: "Local runner stream-client limit reached" });
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      for (const record of entry.history) {
        writeRecord(response, record);
      }
      if (entry.finished) {
        response.end();
      } else {
        entry.clients.add(response);
        request.on("close", () => entry.clients.delete(response));
      }
      return;
    }
    if (request.method === "POST" && action === "interrupt") {
      try {
        await readJson(request, limits.maxRequestBodyBytes);
        const receipt = await entry.handle.interrupt("browser_operator");
        json(response, 200, receipt);
      } catch (error) {
        sendError(response, error, 409);
      }
      return;
    }
    if (request.method === "POST" && action === "resolve") {
      try {
        const body = await readJson(request, limits.maxRequestBodyBytes);
        const receipt = await entry.handle.resolveRequest(
          body.requestId,
          body.response ?? {},
        );
        json(response, 200, receipt);
      } catch (error) {
        sendError(response, error, 409);
      }
      return;
    }
    json(response, 405, { error: "Method not allowed" });
  };
}

export function localRunnerBrowserServerPlugin(options = {}) {
  const middleware = createLocalRunnerBrowserMiddleware(options);
  return {
    name: "paperclip-runner-local-runner-live-server",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export const localRunnerBrowserServerInternals = {
  assertTrustedTransport,
  isLoopbackAddress,
  readJson,
};
