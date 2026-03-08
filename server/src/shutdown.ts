const DEFAULT_TIMEOUT_MS = 5000;

export interface ShutdownDeps {
  server: { close: (cb: (err?: Error) => void) => void };
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  embeddedPostgres: { stop: () => Promise<void> } | null;
  embeddedPostgresStartedByThisProcess: boolean;
  timeoutMs?: number;
}

export function createShutdown(deps: ShutdownDeps) {
  return async (signal: "SIGINT" | "SIGTERM") => {
    deps.logger.info({ signal }, "Shutting down server");

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      deps.logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, timeoutMs);
    forceExitTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        deps.server.close((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      deps.logger.error({ err }, "Error closing HTTP server");
    }

    if (deps.embeddedPostgres && deps.embeddedPostgresStartedByThisProcess) {
      try {
        await deps.embeddedPostgres.stop();
      } catch (err) {
        deps.logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
      }
    }

    process.exit(0);
  };
}
