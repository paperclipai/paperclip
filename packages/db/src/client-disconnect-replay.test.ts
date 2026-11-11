import net from "node:net";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { closeRegisteredClients, createDb } from "./client.js";

/** A wire peer that receives the statement, then loses its acknowledgement. */
async function startDisconnectingServer() {
  const sockets = new Set<net.Socket>();
  let receivedEffects = 0;
  const extendedExecutions: Array<{ statement: string; prepared: boolean; parameters: Array<string | null> }> = [];
  const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const parseComplete = Buffer.from([0x31, 0, 0, 0, 4]);
  const bindComplete = Buffer.from([0x32, 0, 0, 0, 4]);
  const emptyRowDescription = Buffer.from([0x54, 0, 0, 0, 6, 0, 0]);
  const commandComplete = Buffer.from([0x43, 0, 0, 0, 0x0d, ...Buffer.from("SELECT 0\0")]);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let greeted = false;
    let pending = Buffer.alloc(0);
    const statements = new Map<string, { text: string; parameterTypes: number[] }>();
    const portals = new Map<string, { statement: string; prepared: boolean; parameters: Array<string | null> }>();
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
        } else if (message[0] === 0x50) { // Parse
          const nameEnd = message.indexOf(0, 5);
          const textEnd = message.indexOf(0, nameEnd + 1);
          const name = message.toString("utf8", 5, nameEnd);
          const text = message.toString("utf8", nameEnd + 1, textEnd);
          const count = message.readUInt16BE(textEnd + 1);
          const parameterTypes = Array.from({ length: count }, (_, index) =>
            message.readUInt32BE(textEnd + 3 + index * 4) || 23); // int4 for this fixture's integer parameters.
          statements.set(name, { text, parameterTypes });
          socket.write(parseComplete);
        } else if (message[0] === 0x44) { // Describe statement
          const name = message.toString("utf8", 6, message.length - 1);
          const statement = statements.get(name)!;
          const description = Buffer.alloc(7 + statement.parameterTypes.length * 4);
          description[0] = 0x74; // ParameterDescription
          description.writeUInt32BE(description.length - 1, 1);
          description.writeUInt16BE(statement.parameterTypes.length, 5);
          statement.parameterTypes.forEach((type, index) => description.writeUInt32BE(type, 7 + index * 4));
          socket.write(Buffer.concat([description, emptyRowDescription]));
        } else if (message[0] === 0x42) { // Bind
          const portalEnd = message.indexOf(0, 5);
          const nameEnd = message.indexOf(0, portalEnd + 1);
          const portal = message.toString("utf8", 5, portalEnd);
          const name = message.toString("utf8", portalEnd + 1, nameEnd);
          let offset = nameEnd + 3 + message.readUInt16BE(nameEnd + 1) * 2;
          const count = message.readUInt16BE(offset);
          offset += 2;
          const parameters: Array<string | null> = [];
          for (let index = 0; index < count; index++) {
            const length = message.readInt32BE(offset);
            offset += 4;
            parameters.push(length === -1 ? null : message.toString("utf8", offset, offset + length));
            if (length !== -1) offset += length;
          }
          portals.set(portal, { statement: statements.get(name)!.text, prepared: name.length > 0, parameters });
          socket.write(bindComplete);
        } else if (message[0] === 0x45) { // Execute: Parse/Describe alone cannot execute an effect.
          const execution = portals.get(message.toString("utf8", 5, message.indexOf(0, 5)))!;
          extendedExecutions.push(execution);
          if (execution.statement.includes("disconnect_effect")) {
            receivedEffects += 1;
            socket.destroy();
            return;
          }
          socket.write(commandComplete);
        } else if (message[0] === 0x53) { // Sync
          socket.write(ready);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://test:test@127.0.0.1:${port}/test`,
    receivedEffects: () => receivedEffects,
    extendedExecutions: () => extendedExecutions,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("database connection loss after statement delivery", () => {
  it.each(["drizzle", "prepared"] as const)("does not replay a parameterized mutation (%s)", async (surface) => {
    const peer = await startDisconnectingServer();
    try {
      // Keep the default client settings. Drizzle uses unsafe(), which selects
      // unnamed statements; tagged client queries use named prepared statements.
      const db = createDb(peer.url, { maxConnections: 1, connectTimeoutSeconds: 2 });
      const client = db.$client;
      const pending = surface === "drizzle"
        ? db.execute(sql`insert into disconnect_effect(value) values (${42})`)
        : client`insert into disconnect_effect(value) values (${42})`;
      const error = await pending.then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const driverError = error instanceof Error && error.cause ? error.cause : error;
      expect(driverError).toMatchObject({
        code: "CONNECTION_CLOSED",
        message: expect.stringContaining("write CONNECTION_CLOSED"),
      });
      expect(peer.receivedEffects()).toBe(1);
      expect(peer.extendedExecutions().filter((execution) => execution.statement.includes("disconnect_effect")))
        .toEqual([{ statement: "insert into disconnect_effect(value) values ($1)", prepared: surface === "prepared", parameters: ["42"] }]);

      const freshQuery = surface === "drizzle" ? db.execute(sql`select ${7}`) : client`select ${7}`;
      await expect(freshQuery).resolves.toBeDefined();
      expect(peer.extendedExecutions().at(-1))
        .toEqual({ statement: "select $1", prepared: surface === "prepared", parameters: ["7"] });
      expect(peer.receivedEffects()).toBe(1);
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.url);
    }
  });

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
