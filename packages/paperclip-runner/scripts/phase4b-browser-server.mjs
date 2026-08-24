import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Mounts the Phase 4b demo-server routes inside the standalone Vite devtool.
 *
 * The browser never talks to a provider. Only this Node process starts a
 * driver, owns the working directory, and reads any provider login. The
 * default driver replays deterministic demo manifests; setting
 * `PAPERCLIP_PHASE4B_DRIVER=codex` swaps in the real Codex app-server driver
 * behind exactly the same routes.
 */
async function loadRunner() {
  return import(new URL("../dist/index.js", import.meta.url).href);
}

async function createWorkingDirectory() {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  return mkdtemp(resolve(scratchRoot, "phase4b-browser-"));
}

export function createPhase4bBrowserMiddleware(options = {}) {
  const load = options.loadRunner ?? loadRunner;
  const driverMode = options.driverMode ?? process.env.PAPERCLIP_PHASE4B_DRIVER ?? "demo";
  const chunkDelayMs = Number.parseInt(
    options.chunkDelayMs ?? process.env.PAPERCLIP_PHASE4B_CHUNK_DELAY_MS ?? "45",
    10,
  );
  // Abandoned demo sessions hold their slot until the process exits, so a long
  // scripted run needs headroom the interactive default does not. The server
  // still clamps this to its own hard ceiling.
  const maxActiveSessions = Number.parseInt(
    options.maxActiveSessions ?? process.env.PAPERCLIP_PHASE4B_MAX_SESSIONS ?? "",
    10,
  );
  let bootstrap = null;
  let bindHost = options.bindHost ?? "127.0.0.1";

  async function ready(requestedBindHost = bindHost) {
    bindHost = requestedBindHost;
    if (bootstrap !== null) return bootstrap;
    bootstrap = (async () => {
      const runner = await load();
      runner.assertPhase4bLoopbackBindHost(bindHost);
      const workingDirectory =
        options.workingDirectory ?? (await createWorkingDirectory());
      const server = new runner.Phase4bDemoServer({
        host: bindHost,
        workingDirectory,
        manifests: runner.phase4bDemoManifestCatalogue(),
        ...(Number.isInteger(maxActiveSessions) ? { maxActiveSessions } : {}),
        driverFactory: (taskEnvelope, manifestId) =>
          driverMode === "codex"
            ? new runner.CodexAppServerDriver({
                taskEnvelope,
                onDiagnostic: (message) => process.stderr.write(`[phase4b] ${message}\n`),
              })
            : new runner.Phase4bScriptedDriver({
                manifestId: manifestId ?? "completion",
                chunkDelayMs: Number.isInteger(chunkDelayMs) ? chunkDelayMs : 45,
              }),
      });
      return { handle: server.middleware(), server, workingDirectory };
    })();
    return bootstrap;
  }

  const middleware = async function phase4bMiddleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://phase4b.local");
    if (!url.pathname.startsWith("/api/phase4b/")) {
      next();
      return;
    }
    try {
      const { handle } = await ready();
      handle(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: "phase4b_unavailable",
        message: String(error instanceof Error ? error.message : error),
      }));
    }
  };
  middleware.close = async () => {
    if (bootstrap === null) return;
    const { server } = await bootstrap;
    await server.close();
  };
  middleware.prepare = ready;
  return middleware;
}

export function phase4bBrowserServerPlugin(options = {}) {
  const middlewares = new Set();
  async function mount(server, host) {
    const middleware = createPhase4bBrowserMiddleware({ ...options, bindHost: host });
    await middleware.prepare(host);
    middlewares.add(middleware);
    server.middlewares.use(middleware);
    server.httpServer?.once("close", () => {
      middlewares.delete(middleware);
      void middleware.close();
    });
  }
  return {
    name: "paperclip-runner-phase4b-live-console-server",
    async configureServer(server) {
      const host = server.config.server.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
    async configurePreviewServer(server) {
      const host = server.config.preview.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
  };
}
