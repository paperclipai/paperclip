import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { createPostgresProtocolObserver } from "./postgres-proxy.js";

const realTimeout = globalThis.setTimeout;

export function databasePort(databaseUrl: string) {
  return Number(new URL(databaseUrl).port) || 5432;
}

export function trackDatabaseConnectionStartup(port: number) {
  const starting = new Set<Socket>();
  let errors: Error[] = [];
  const subscriber = (message: unknown) => {
    const socket = (message as { socket: Socket }).socket;
    starting.add(socket);
    socket.once("close", () => starting.delete(socket));
    socket.once("connect", () => {
      if (socket.remotePort !== port) { starting.delete(socket); return; }
      const observer = createPostgresProtocolObserver(() => {});
      const onData = (chunk: Buffer) => {
        try { observer.backend(chunk); }
        catch (error) { errors.push(error as Error); starting.delete(socket); socket.off("data", onData); return; }
        if (observer.ready) { starting.delete(socket); socket.off("data", onData); }
      };
      socket.on("data", onData);
    });
  };
  channel("net.client.socket").subscribe(subscriber);
  function failIfObservationFailed() {
    if (!errors.length) return;
    const failed = errors;
    errors = [];
    throw new AggregateError(failed, "Database connection startup could not be observed");
  }
  return {
    get starting() { return starting.size; },
    async waitUntilStarted(timeoutMs = 30_000) {
      const deadline = performance.now() + timeoutMs;
      while (starting.size > 0) {
        failIfObservationFailed();
        if (performance.now() >= deadline) throw new Error(`Database connection startup did not finish within ${timeoutMs}ms`);
        await new Promise(resolve => realTimeout(resolve, 5));
      }
      failIfObservationFailed();
    },
    async advanceAfterStartup(tick: (ms: number) => void, ms: number, timeoutMs = 30_000) {
      do await this.waitUntilStarted(timeoutMs); while (starting.size > 0);
      tick(ms);
    },
    dispose() { channel("net.client.socket").unsubscribe(subscriber); },
  };
}
