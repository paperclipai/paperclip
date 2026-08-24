import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PHASE2_BROWSER_LIMITS = Object.freeze({
  maxActiveRuns: 4,
  maxRetainedRuns: 16,
  maxRequestBodyBytes: 16 * 1024,
  maxStreamClientsPerRun: 8,
});

class Phase2HttpError extends Error {
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
      overrides.maxActiveRuns ?? PHASE2_BROWSER_LIMITS.maxActiveRuns,
      "maxActiveRuns",
    ),
    maxRetainedRuns: positiveInteger(
      overrides.maxRetainedRuns ?? PHASE2_BROWSER_LIMITS.maxRetainedRuns,
      "maxRetainedRuns",
    ),
    maxRequestBodyBytes: positiveInteger(
      overrides.maxRequestBodyBytes ?? PHASE2_BROWSER_LIMITS.maxRequestBodyBytes,
      "maxRequestBodyBytes",
    ),
    maxStreamClientsPerRun: positiveInteger(
      overrides.maxStreamClientsPerRun ??
        PHASE2_BROWSER_LIMITS.maxStreamClientsPerRun,
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
    throw new Phase2HttpError(403, "Phase 2 requests require a loopback Host");
  }
  const protocol = request.socket.encrypted === true ? "https:" : "http:";
  let hostUrl;
  try {
    hostUrl = new URL(`${protocol}//${host}`);
  } catch {
    throw new Phase2HttpError(403, "Phase 2 requests require a valid loopback Host");
  }
  if (!isLoopbackAddress(hostUrl.hostname)) {
    throw new Phase2HttpError(403, "Phase 2 requests require a loopback Host");
  }
  const defaultPort = protocol === "https:" ? 443 : 80;
  const hostPort = hostUrl.port.length === 0 ? defaultPort : Number(hostUrl.port);
  if (hostPort !== request.socket.localPort) {
    throw new Phase2HttpError(403, "Phase 2 Host must name the listening loopback port");
  }
  return hostUrl.origin;
}

function assertTrustedTransport(request) {
  if (
    !isLoopbackAddress(request.socket.localAddress) ||
    !isLoopbackAddress(request.socket.remoteAddress)
  ) {
    throw new Phase2HttpError(403, "Phase 2 is available only over loopback");
  }
  const expectedOrigin = requestOrigin(request);
  const origin = request.headers.origin;
  if (Array.isArray(origin) || (typeof origin === "string" && origin !== expectedOrigin)) {
    throw new Phase2HttpError(403, "Phase 2 requests must be same-origin");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    Array.isArray(fetchSite) ||
    (typeof fetchSite === "string" && !["same-origin", "none"].includes(fetchSite))
  ) {
    throw new Phase2HttpError(403, "Phase 2 cross-site requests are forbidden");
  }
}

function declaredBodyBytes(request) {
  const header = request.headers["content-length"];
  if (header === undefined) {
    return null;
  }
  if (Array.isArray(header) || !/^\d+$/.test(header)) {
    throw new Phase2HttpError(400, "Invalid Content-Length");
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value)) {
    throw new Phase2HttpError(413, "Phase 2 request body is too large");
  }
  return value;
}

function rejectDeclaredOversize(request, maxBytes) {
  const contentLength = declaredBodyBytes(request);
  if (contentLength !== null && contentLength > maxBytes) {
    request.resume();
    throw new Phase2HttpError(
      413,
      `Phase 2 request body exceeds ${maxBytes} bytes`,
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
    throw new Phase2HttpError(415, "Phase 2 request bodies must use application/json");
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
          new Phase2HttpError(
            413,
            `Phase 2 request body exceeds ${maxBytes} bytes`,
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
        reject(new Phase2HttpError(400, "Phase 2 request body must be valid JSON"));
      }
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new Phase2HttpError(400, "Request body was aborted"));

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
  const status = error instanceof Phase2HttpError ? error.status : fallbackStatus;
  const message = error instanceof Error ? error.message : String(error);
  json(response, status, { error: message });
}

async function loadPhase2Runner() {
  const runnerModuleUrl = new URL(
    "../dist/mock-core/phase2-local-runner.js",
    import.meta.url,
  ).href;
  return import(runnerModuleUrl);
}

async function loadPhase3Runner() {
  const runnerModuleUrl = new URL(
    "../dist/mock-core/phase3-recovery.js",
    import.meta.url,
  ).href;
  return import(runnerModuleUrl);
}

export function createPhase2BrowserMiddleware(options = {}) {
  const limits = normalizeLimits(options.limits);
  const loadRunner = options.loadRunner ?? loadPhase2Runner;
  const loadRecoveryRunner = options.loadRecoveryRunner ?? loadPhase3Runner;
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
    const url = new URL(request.url ?? "/", "http://phase2.local");
    if (!url.pathname.startsWith("/api/phase2/") && url.pathname !== "/api/phase3/recovery") {
      next();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/phase3/recovery") {
      let storageDirectory = null;
      try {
        assertTrustedTransport(request);
        rejectDeclaredOversize(request, limits.maxRequestBodyBytes);
        const body = await readJson(request, limits.maxRequestBodyBytes);
        const recovery = await loadRecoveryRunner();
        const scratchRoot =
          process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
          process.env.PAPERCLIP_SCRATCH_DIR ??
          tmpdir();
        storageDirectory = await mkdtemp(
          join(scratchRoot, "paperclip-runner-browser-phase3-"),
        );
        json(response, 200, await recovery.runPhase3Recovery({
          fault: body.fault ?? "lost-ack",
          stateDirectory: storageDirectory,
        }));
      } catch (error) {
        sendError(response, error);
      } finally {
        if (storageDirectory !== null) {
          await rm(storageDirectory, { recursive: true, force: true });
        }
      }
      return;
    }

    try {
      assertTrustedTransport(request);
      rejectDeclaredOversize(request, limits.maxRequestBodyBytes);
    } catch (error) {
      sendError(response, error, 403);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/phase2/runs") {
      if (activeRunCount() + startingRuns >= limits.maxActiveRuns) {
        json(response, 429, { error: "Phase 2 active-run limit reached" });
        return;
      }
      pruneFinishedRuns(limits.maxRetainedRuns - 1);
      if (runs.size + startingRuns >= limits.maxRetainedRuns) {
        json(response, 429, { error: "Phase 2 retained-run limit reached" });
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
        const handle = await runner.startPhase2Scenario({
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
      /^\/api\/phase2\/runs\/([^/]+)(?:\/(events|interrupt|resolve))?$/,
    );
    if (match === null) {
      json(response, 404, { error: "Phase 2 route not found" });
      return;
    }
    const entry = runs.get(match[1]);
    if (entry === undefined) {
      json(response, 404, { error: "Phase 2 run not found" });
      return;
    }
    const action = match[2];
    if (request.method === "GET" && action === "events") {
      if (!entry.finished && entry.clients.size >= limits.maxStreamClientsPerRun) {
        json(response, 429, { error: "Phase 2 stream-client limit reached" });
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

export function phase2BrowserServerPlugin(options = {}) {
  const middleware = createPhase2BrowserMiddleware(options);
  return {
    name: "paperclip-runner-phase2-live-server",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export const phase2BrowserServerInternals = {
  assertTrustedTransport,
  isLoopbackAddress,
  readJson,
};
