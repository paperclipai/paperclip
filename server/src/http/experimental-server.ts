import { createHttpApp, type HttpAppOptions } from "./app.js";

export type ExperimentalHttpServerOptions = Omit<HttpAppOptions, "authReady"> & {
  hostname?: string;
  port?: number;
};

export type ExperimentalHttpServer = {
  server: Bun.Server<undefined>;
  ready: Promise<void>;
  stop: (force?: boolean) => Promise<void>;
};

/**
 * Starts only the isolated native HTTP boundary; the production Express
 * bootstrap, database, workers, auth, and WebSockets remain untouched.
 */
export function startExperimentalHttpServer(
  options: ExperimentalHttpServerOptions,
): ExperimentalHttpServer {
  const app = createHttpApp({ ...options, authReady: false });
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port ?? 0,
    fetch: app.fetch,
  });

  const ready = server.port !== undefined && server.port > 0 ? Promise.resolve() : Promise.reject(
    new Error("Experimental Bun HTTP server did not report a listening port"),
  );

  return {
    server,
    ready,
    stop: (force = false) => server.stop(force),
  };
}
