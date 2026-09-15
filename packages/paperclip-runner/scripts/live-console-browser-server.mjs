import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Mounts the Live console demo-server routes inside the standalone Vite devtool.
 *
 * The browser never talks to a provider. Only this Node process starts a
 * driver, owns the working directory, and reads any provider login. The
 * default driver replays deterministic demo manifests; setting
 * `PAPERCLIP_LIVE_CONSOLE_DRIVER=codex` swaps in the real Codex app-server driver
 * behind exactly the same routes.
 */
async function loadRunner() {
  return import(new URL("../dist/index.js", import.meta.url).href);
}

async function createWorkingDirectory() {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  return mkdtemp(resolve(scratchRoot, "live-console-browser-"));
}

export function createLiveConsoleBrowserMiddleware(options = {}) {
  const load = options.loadRunner ?? loadRunner;
  const driverMode = options.driverMode ?? process.env.PAPERCLIP_LIVE_CONSOLE_DRIVER ?? "demo";
  const chunkDelayMs = Number.parseInt(
    options.chunkDelayMs ?? process.env.PAPERCLIP_LIVE_CONSOLE_CHUNK_DELAY_MS ?? "45",
    10,
  );
  // Abandoned demo sessions hold their slot until the process exits, so a long
  // scripted run needs headroom the interactive default does not. The server
  // still clamps this to its own hard ceiling.
  const maxActiveSessions = Number.parseInt(
    options.maxActiveSessions ?? process.env.PAPERCLIP_LIVE_CONSOLE_MAX_SESSIONS ?? "",
    10,
  );
  let bootstrap = null;
  let bindHost = options.bindHost ?? "127.0.0.1";

  async function ready(requestedBindHost = bindHost) {
    bindHost = requestedBindHost;
    if (bootstrap !== null) return bootstrap;
    bootstrap = (async () => {
      const runner = await load();
      runner.assertLiveConsoleLoopbackBindHost(bindHost);
      const workingDirectory =
        options.workingDirectory ?? (await createWorkingDirectory());
      const server = new runner.LiveConsoleDemoServer({
        host: bindHost,
        workingDirectory,
        manifests: runner.liveConsoleDemoManifestCatalogue(),
        ...(Number.isInteger(maxActiveSessions) ? { maxActiveSessions } : {}),
        driverFactory: (taskEnvelope, manifestId) =>
          driverMode === "codex"
            ? new runner.CodexAppServerDriver({
                taskEnvelope,
                conversationMode: manifestId === "chat" ? "direct" : "task",
                onDiagnostic: (message) => process.stderr.write(`[liveConsole] ${message}\n`),
              })
            : new runner.LiveConsoleScriptedDriver({
                manifestId: manifestId ?? "completion",
                chunkDelayMs: Number.isInteger(chunkDelayMs) ? chunkDelayMs : 45,
              }),
      });
      return { handle: server.middleware(), server, workingDirectory };
    })();
    return bootstrap;
  }

  const middleware = async function liveConsoleMiddleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://liveConsole.local");
    if (!url.pathname.startsWith("/api/liveConsole/")) {
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
        error: "liveConsole_unavailable",
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

export function liveConsoleBrowserServerPlugin(options = {}) {
  const middlewares = new Set();
  async function mount(server, host) {
    const middleware = createLiveConsoleBrowserMiddleware({ ...options, bindHost: host });
    await middleware.prepare(host);
    middlewares.add(middleware);
    server.middlewares.use(middleware);
    server.httpServer?.once("close", () => {
      middlewares.delete(middleware);
      void middleware.close();
    });
  }
  return {
    name: "paperclip-runner-live-console-server",
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
