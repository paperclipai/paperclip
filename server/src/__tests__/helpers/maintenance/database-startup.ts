import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { createPostgresProtocolObserver } from "./postgres-proxy.js";

const realTimeout = globalThis.setTimeout;

export function trackDatabaseConnectionStartup(databasePort: number) {
  const starting = new Set<Socket>();
  const errors: Error[] = [];
  const subscriber = (message: unknown) => {
    const socket = (message as { socket: Socket }).socket;
    starting.add(socket);
    socket.once("close", () => starting.delete(socket));
    socket.once("connect", () => {
      if (socket.remotePort !== databasePort) { starting.delete(socket); return; }
      const observer = createPostgresProtocolObserver(() => {});
      const onData = (chunk: Buffer) => {
        try { observer.backend(chunk); }
        catch (error) { errors.push(error as Error); }
        if (observer.ready || errors.length) { starting.delete(socket); socket.off("data", onData); }
      };
      socket.on("data", onData);
    });
  };
  channel("net.client.socket").subscribe(subscriber);
  return {
    get starting() { return starting.size; },
    async waitUntilStarted(timeoutMs = 30_000) {
      const deadline = performance.now() + timeoutMs;
      while (starting.size > 0) {
        if (errors.length) throw new AggregateError(errors, "Database connection startup could not be observed");
        if (performance.now() >= deadline) throw new Error(`Database connection startup did not finish within ${timeoutMs}ms`);
        await new Promise(resolve => realTimeout(resolve, 5));
      }
      if (errors.length) throw new AggregateError(errors, "Database connection startup could not be observed");
    },
    dispose() { channel("net.client.socket").unsubscribe(subscriber); },
  };
}
