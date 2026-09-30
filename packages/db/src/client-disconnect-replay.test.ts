import net from "node:net";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { closeRegisteredClients, createDb } from "./client.js";

/** A wire peer that receives the statement, then loses its acknowledgement. */
async function startDisconnectingServer() {
  const sockets = new Set<net.Socket>();
  let receivedEffects = 0;
  const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const commandComplete = Buffer.from([0x43, 0, 0, 0, 0x0d, ...Buffer.from("SELECT 0\0")]);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let greeted = false;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (greeted ? 5 : 4)) {
        const size = greeted ? pending.readUInt32BE(1) + 1 : pending.readUInt32BE(0);
        if (pending.length < size) return;
        const message = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (!greeted) {
          greeted = true;
          socket.write(Buffer.concat([authOk, ready]));
        } else if (message[0] === 0x51) { // Simple Query
          const statement = message.subarray(5, -1).toString();
          if (statement.includes("disconnect_effect")) {
            receivedEffects += 1;
            // The whole statement reached the peer. Its outcome is now
            // ambiguous to the client, even though the error says "write".
            socket.destroy();
            return;
          }
          socket.write(Buffer.concat([commandComplete, ready]));
        } else if (message[0] === 0x53) { // Sync after the driver's extended type-discovery query.
          socket.write(Buffer.concat([
            Buffer.from([0x31, 0, 0, 0, 4]), // ParseComplete
            Buffer.from([0x32, 0, 0, 0, 4]), // BindComplete
            Buffer.from([0x54, 0, 0, 0, 6, 0, 0]), // Empty RowDescription
            commandComplete,
            ready,
          ]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://test:test@127.0.0.1:${port}/test`,
    receivedEffects: () => receivedEffects,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("database connection loss after statement delivery", () => {
  for (const statement of [
    "insert into disconnect_effect default values",
    "select disconnect_effect()",
    "with effect as (insert into disconnect_effect default values returning *) select * from effect",
  ]) {
    it.each(["rows", "values"] as const)(`does not replay ${statement} (%s)`, async (shape) => {
      const peer = await startDisconnectingServer();
      try {
        const db = createDb(peer.url, { maxConnections: 1, connectTimeoutSeconds: 2, prepare: false });
        const client = (db as unknown as { $client: Sql }).$client;
        const pending = shape === "rows"
          ? db.execute(sql.raw(statement))
          : client.unsafe(statement).values();
        // This is the real postgres.js error, not a mock that invents a
        // distinct "read CONNECTION_CLOSED" shape for an in-flight query.
        const error = await pending.then(() => null, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        const driverError = error instanceof Error && error.cause ? error.cause : error;
        expect(driverError).toMatchObject({
          code: "CONNECTION_CLOSED",
          message: expect.stringContaining("write CONNECTION_CLOSED"),
        });
        expect(peer.receivedEffects()).toBe(1);

        // Failing the ambiguous statement must not poison the pool. A new
        // operation can reconnect, without resubmitting the failed effect.
        await expect(db.execute(sql`select 0`)).resolves.toBeDefined();
        expect(peer.receivedEffects()).toBe(1);
      } finally {
        await peer.close();
        await closeRegisteredClients(peer.url);
      }
    });
  }
});
