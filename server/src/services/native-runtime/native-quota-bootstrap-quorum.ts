import { createServer, type Server } from "node:net";

/** The caller must establish provenance for the three ports independently.
 * The callback runs while two exact loopback listeners remain held, and must
 * include its transaction commit before resolving. */
export async function withNativeBootstrapLifetimeQuorum<T>(ports: readonly number[], action: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (process.platform === "win32" || ports.length !== 3 || new Set(ports).size !== 3 ||
      ports.some(port => !Number.isInteger(port) || port < 49_152 || port > 65_535)) return { acquired: false };
  const listeners: Server[] = [];
  try {
    for (const port of ports) {
      const server = createServer(socket => socket.destroy());
      const bound = await new Promise<boolean>((resolve, reject) => {
        server.once("error", error => {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(false);
          else reject(error);
        });
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
      });
      if (bound) listeners.push(server);
      if (listeners.length === 2) return { acquired: true, value: await action() };
    }
    return { acquired: false };
  } finally {
    await Promise.all(listeners.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}
